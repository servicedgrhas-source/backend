import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import ExcelJS from 'exceljs';
import { Repository } from 'typeorm';
import type { UtilisateurConnecte } from '../auth/auth';
import { lireClasseur } from '../common/excel';
import { codeDepartement } from '../common/referentiels';
import { cleCompacte, enTexte } from '../common/texte';
import { JournalService } from '../core/core.service';
import { Departement, Structure } from '../entities';
import { CYCLES_STRUCTURE, TYPES_LOCALITE } from './catalogue';

/**
 * Import des établissements et des inspections (DG, 23/10/2026) : chaque école appartient à une
 * inspection de son département (une ou plusieurs par cycle), elle-même rattachée à la DDEPPSA.
 * Une fois importées, les écoles se choisissent dans une liste au lieu d'être tapées.
 */

const COL = {
  departement: ['DEPARTEMENT', 'DEPARTEMENTSCOLAIRE', 'DDEPPSA'],
  inspection: [
    'INSPECTION',
    'CIRCONSCRIPTION',
    'CIRCONSCRIPTIONSCOLAIRE',
    'INSPECTIONDERATTACHEMENT',
  ],
  cycle: ['CYCLE', 'NIVEAU', 'ORDREDENSEIGNEMENT'],
  etablissement: [
    'ETABLISSEMENT',
    'NOMDELETABLISSEMENT',
    'ECOLE',
    'NOMDELECOLE',
    'ETABLISSEMENTSCOLAIRE',
  ],
  typeLocalite: ['TYPEDELOCALITE', 'TYPELOCALITE'],
  localite: [
    'LOCALITE',
    'VILLEDISTRICTARRONDISSEMENT',
    'DISTRICTCOMMUNEARRONDISSEMENT',
    'DISTRICT',
    'ARRONDISSEMENT',
    'COMMUNE',
    'VILLE',
  ],
};

/** Cycle d'après le texte de la colonne, ou d'après le nom de l'inspection ou de l'école. */
export function cycleDepuis(...textes: unknown[]): string | null {
  for (const t of textes) {
    const k = cleCompacte(t);
    if (!k) continue;
    if (CYCLES_STRUCTURE[k]) return k;
    if (/PRESCO|MATERNEL|JARDIN|CENTREDEVEIL|CEPRESC/.test(k))
      return 'PRESCOLAIRE';
    if (/ALPHA/.test(k)) return 'ALPHABETISATION';
    if (/LYCEE|^LYC|LTP|LYCEETECH/.test(k)) return 'LYCEE';
    if (/COLLEGE|^CEG|^ICEG|CEG|^CET|ENSEIGNEMENTGENERAL|SECONDAIRE1/.test(k))
      return 'COLLEGE';
    if (/PRIMAIRE|^EPP|^EP\b|^ECOLE|^IEP|^ICS|^IP\b/.test(k)) return 'PRIMAIRE';
  }
  return null;
}

function typeLocaliteDepuis(t: unknown, colonne: string | null): string | null {
  const k = cleCompacte(t);
  if (TYPES_LOCALITE[k]) return k;
  if (/^DIST/.test(k)) return 'DISTRICT';
  if (/^ARR/.test(k)) return 'ARRONDISSEMENT';
  if (/^COM/.test(k)) return 'COMMUNE';
  // Colonne nommée « District », « Arrondissement »… : son nom donne le type
  const c = colonne?.replace(/_\d+$/, '') ?? '';
  return TYPES_LOCALITE[c] ? c : null;
}

const premiere = (entetes: string[], noms: string[]) => {
  for (const n of noms) {
    const e = entetes.find((x) => x.replace(/_\d+$/, '') === n);
    if (e) return e;
  }
  return null;
};

export interface RapportImportStructures {
  essai: boolean;
  lues: number;
  inspections: { creees: number; existantes: number; exemples: string[] };
  etablissements: {
    crees: number;
    misAJour: number;
    inchanges: number;
    exemples: string[];
  };
  sansInspection: number;
  sansCycle: number;
  ignorees: { raison: string; n: number; exemples: string[] }[];
}

@Injectable()
export class ImportStructuresService {
  constructor(
    @InjectRepository(Structure)
    private readonly structures: Repository<Structure>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    private readonly journal: JournalService,
  ) {}

  async modele(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Etablissements');
    ws.columns = [
      { header: 'DEPARTEMENT', key: 'd', width: 18 },
      { header: 'INSPECTION', key: 'i', width: 34 },
      { header: 'CYCLE', key: 'c', width: 16 },
      { header: 'ETABLISSEMENT', key: 'e', width: 40 },
      { header: 'TYPE DE LOCALITE', key: 't', width: 18 },
      { header: 'LOCALITE', key: 'l', width: 24 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.addRow({
      d: 'Bouenza',
      i: 'Inspection du primaire Nkayi 1',
      c: 'Primaire',
      e: 'EPP Nkayi Centre',
      t: 'Commune',
      l: 'Nkayi',
    });
    ws.addRow({
      d: 'Bouenza',
      i: 'Inspection des CEG Bouenza 1',
      c: 'Collège',
      e: 'CEG Loudima',
      t: 'District',
      l: 'Loudima',
    });
    ws.addRow({
      d: 'Brazzaville',
      i: 'Inspection du préscolaire Brazzaville 2',
      c: 'Préscolaire',
      e: 'Centre préscolaire de Moungali',
      t: 'Arrondissement',
      l: 'Moungali (4)',
    });
    const aide = wb.addWorksheet('Consignes');
    aide.getColumn(1).width = 110;
    for (const l of [
      'Une ligne par école. Le département et l’inspection sont répétés sur chaque ligne.',
      'Une ligne avec seulement le département, l’inspection et le cycle crée l’inspection sans école.',
      `CYCLE : ${Object.values(CYCLES_STRUCTURE).join(', ')}. Vide : déduit du nom de l’inspection ou de l’école (EPP, CEG, Lycée…).`,
      `TYPE DE LOCALITE : ${Object.values(TYPES_LOCALITE).join(', ')} (district en zone rurale, commune ou arrondissement en ville). Pas de village ni de quartier.`,
      'Un nom déjà connu dans la même inspection (ou le même département) n’est pas créé deux fois : son cycle et sa localisation sont mis à jour.',
    ])
      aide.addRow([l]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async importer(
    u: UtilisateurConnecte,
    contenu: Buffer,
    essai: boolean,
  ): Promise<RapportImportStructures> {
    const feuilles = (
      await lireClasseur(contenu, [COL.departement.join('|')])
    ).filter(
      (f) =>
        premiere(f.entetes, COL.etablissement) ||
        premiere(f.entetes, COL.inspection),
    );
    if (!feuilles.length)
      throw new BadRequestException(
        'Aucune feuille avec les colonnes « Département » et « Établissement » (ou « Inspection »). Partez du modèle Excel.',
      );
    const deps = await this.deps.find();
    const depParCode = new Map(deps.map((d) => [d.code, d]));
    const tout = await this.structures.find();
    const ddeppsa = new Map<number, Structure>();
    for (const s of tout)
      if (
        s.type === 'DDEPPSA' &&
        s.departementId &&
        !ddeppsa.has(s.departementId)
      )
        ddeppsa.set(s.departementId, s);
    const cleNom = (s: { nom: string }) => cleCompacte(s.nom);
    // Inspections par DDEPPSA ; écoles par inspection et par département
    const inspections = new Map<string, Structure>();
    const ecoles = new Map<string, Structure>();
    for (const s of tout) {
      if (s.type === 'INSPECTION') {
        inspections.set(`${s.departementId}|${cleNom(s)}`, s);
        inspections.set(`${s.departementId}|${cleCompacte(s.sigle)}`, s);
      }
      if (s.type === 'ETABLISSEMENT')
        ecoles.set(`${s.departementId}|${s.parentId}|${cleNom(s)}`, s);
    }
    const ecoleDuDepartement = (depId: number, nom: string) =>
      tout.find(
        (s) =>
          s.type === 'ETABLISSEMENT' &&
          s.departementId === depId &&
          cleNom(s) === cleCompacte(nom),
      );

    const r: RapportImportStructures = {
      essai,
      lues: 0,
      inspections: { creees: 0, existantes: 0, exemples: [] },
      etablissements: { crees: 0, misAJour: 0, inchanges: 0, exemples: [] },
      sansInspection: 0,
      sansCycle: 0,
      ignorees: [],
    };
    const ignorer = (raison: string, ex: string) => {
      const x =
        r.ignorees.find((y) => y.raison === raison) ??
        r.ignorees[r.ignorees.push({ raison, n: 0, exemples: [] }) - 1];
      x.n++;
      if (x.exemples.length < 5) x.exemples.push(ex);
    };
    const aSauver = new Set<Structure>();
    let provisoire = -1;
    const nouvelle = (v: Partial<Structure>) => {
      const s = this.structures.create({ actif: true, ordre: 0, ...v });
      s.id = provisoire--;
      aSauver.add(s);
      tout.push(s);
      return s;
    };

    for (const f of feuilles) {
      const c = Object.fromEntries(
        Object.entries(COL).map(([k, noms]) => [k, premiere(f.entetes, noms)]),
      ) as Record<keyof typeof COL, string | null>;
      for (const l of f.lignes) {
        const ou = `${f.nom}, ligne ${l._ligne}`;
        const nomEcole = c.etablissement
          ? enTexte(l[c.etablissement]).replace(/\s+/g, ' ').trim()
          : '';
        const nomInsp = c.inspection
          ? enTexte(l[c.inspection]).replace(/\s+/g, ' ').trim()
          : '';
        if (!nomEcole && !nomInsp) continue;
        r.lues++;
        const code = codeDepartement(l[c.departement!]);
        const dep = code ? depParCode.get(code) : undefined;
        if (!dep) {
          ignorer(
            'Département non reconnu',
            `${ou} : « ${enTexte(l[c.departement!])} »`,
          );
          continue;
        }
        let dd = ddeppsa.get(dep.id);
        if (!dd) {
          dd = nouvelle({
            type: 'DDEPPSA',
            nom: `Direction départementale de l’enseignement préscolaire, primaire, secondaire et de l’alphabétisation (${dep.nom})`,
            sigle: `DDEPPSA ${dep.nom}`,
            departementId: dep.id,
          });
          ddeppsa.set(dep.id, dd);
        }
        const cycle = cycleDepuis(
          c.cycle ? l[c.cycle] : null,
          nomInsp,
          nomEcole,
        );
        if (!cycle) r.sansCycle++;
        let insp: Structure | undefined;
        if (nomInsp) {
          insp = inspections.get(`${dep.id}|${cleCompacte(nomInsp)}`);
          if (!insp) {
            insp = nouvelle({
              type: 'INSPECTION',
              nom: nomInsp,
              sigle: nomInsp.slice(0, 80),
              parentId: dd.id,
              departementId: dep.id,
              cycle: cycleDepuis(nomInsp) ?? cycle,
            });
            inspections.set(`${dep.id}|${cleCompacte(nomInsp)}`, insp);
            r.inspections.creees++;
            if (r.inspections.exemples.length < 5)
              r.inspections.exemples.push(`${nomInsp} (${dep.nom})`);
          } else if (insp.id > 0 && !aSauver.has(insp)) {
            r.inspections.existantes++;
            if (!insp.cycle && (cycleDepuis(nomInsp) ?? cycle)) {
              insp.cycle = cycleDepuis(nomInsp) ?? cycle;
              aSauver.add(insp);
            }
          }
        }
        if (!nomEcole) continue;
        if (!insp) r.sansInspection++;
        const parent = insp ?? dd;
        const typeLoc =
          c.localite || c.typeLocalite
            ? typeLocaliteDepuis(
                c.typeLocalite ? l[c.typeLocalite] : null,
                c.localite,
              )
            : null;
        const localite = c.localite
          ? enTexte(l[c.localite]).replace(/\s+/g, ' ').trim() || null
          : null;
        let e =
          ecoles.get(`${dep.id}|${parent.id}|${cleCompacte(nomEcole)}`) ??
          ecoleDuDepartement(dep.id, nomEcole);
        if (!e) {
          e = nouvelle({
            type: 'ETABLISSEMENT',
            nom: nomEcole,
            sigle: nomEcole.slice(0, 80),
            parentId: parent.id,
            departementId: dep.id,
            cycle,
            typeLocalite: typeLoc,
            localite,
          });
          ecoles.set(`${dep.id}|${parent.id}|${cleCompacte(nomEcole)}`, e);
          r.etablissements.crees++;
          if (r.etablissements.exemples.length < 5)
            r.etablissements.exemples.push(`${nomEcole} → ${parent.sigle}`);
        } else {
          const avant = JSON.stringify([
            e.parentId,
            e.cycle,
            e.typeLocalite,
            e.localite,
          ]);
          if (insp && e.parentId !== insp.id) e.parentId = insp.id;
          e.cycle = cycle ?? e.cycle;
          e.typeLocalite = typeLoc ?? e.typeLocalite;
          e.localite = localite ?? e.localite;
          if (
            avant !==
            JSON.stringify([e.parentId, e.cycle, e.typeLocalite, e.localite])
          ) {
            if (e.id > 0 && !aSauver.has(e)) r.etablissements.misAJour++;
            aSauver.add(e);
          } else if (e.id > 0) r.etablissements.inchanges++;
        }
      }
    }
    if (essai) return r;

    // Enregistrement dans l'ordre : DDEPPSA, inspections, écoles (les parents d'abord)
    await this.structures.manager.transaction(async (m) => {
      const ids = new Map<number, number>();
      for (const type of ['DDEPPSA', 'INSPECTION', 'ETABLISSEMENT'])
        for (const s of [...aSauver].filter((x) => x.type === type)) {
          const ancienId = s.id;
          if (s.parentId && s.parentId < 0)
            s.parentId = ids.get(s.parentId) ?? null;
          if (ancienId < 0) {
            const valeurs: Partial<Structure> = { ...s };
            delete valeurs.id;
            const enr = await m.save(Structure, valeurs);
            ids.set(ancienId, enr.id);
            s.id = enr.id;
          } else await m.save(Structure, s);
        }
    });
    await this.journal.log(u, 'STRUCTURES_IMPORT', 'structure', null, {
      inspections: r.inspections.creees,
      etablissementsCrees: r.etablissements.crees,
      etablissementsMisAJour: r.etablissements.misAJour,
    });
    return r;
  }
}
