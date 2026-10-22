import {
  AnomaliesService,
  cleTexte,
  dateFr,
  NAISSANCE_IMPROBABLE,
  naissanceImprobable,
  RESSEMBLE,
  TEXTE_PARTAGE,
} from '../common/anomalies';
import { motsDuNom, ressemblance } from '../common/ressemblance';
import { sqlLibelleLot } from '../common/lots';
import { LotsReceptionService } from './lots-reception.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { champ, lireClasseur, type Ligne } from '../common/excel';
import {
  codeCycle,
  codeDepartement,
  reconnaitreDiplome,
} from '../common/referentiels';
import {
  cleCompacte,
  lireDate,
  nettoyer,
  normaliser,
  romainVersEntier,
} from '../common/texte';
import { Affectation, Agent, Departement, RegleDiplome } from '../entities';

export interface RapportImport {
  feuilles: { nom: string; lignes: number }[];
  lignesLues: number;
  crees: number;
  misAJour: number;
  ignorees: number;
  /** Textes enregistrés dans le système et gardés malgré le fichier. */
  textesConserves: number;
  affectationsCreees: number;
  lots: { numero: number; libelle: string; agents: number }[];
  anomalies: Record<string, number>;
  /** Même personne deux fois (nom et date de naissance), dans la base ou entre les feuilles. */
  doublons: number;
  /** Numéros de texte écrits pour plusieurs personnes. */
  textesPartages: number;
}

function entier(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function lotCommission(v: unknown): string | null {
  const s = nettoyer(v);
  if (!s) return null;
  const k = cleCompacte(s);
  if (k.includes('UNIQUE')) return 'Lot unique';
  const m = k.match(/^L(?:OT)?([IVX]+|\d+)$/);
  if (m) return `Lot ${romainVersEntier(m[1]) ?? m[1]}`;
  return s;
}

function typeTexte(v: unknown): 'ARRETE' | 'DECRET' | null {
  const k = cleCompacte(v);
  if (k.startsWith('ARRET')) return 'ARRETE';
  if (k.startsWith('DECR')) return 'DECRET';
  return null;
}

@Injectable()
export class ImportBaseService {
  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Affectation)
    private readonly affectations: Repository<Affectation>,
    @InjectRepository(Departement)
    private readonly deps: Repository<Departement>,
    @InjectRepository(RegleDiplome)
    private readonly regles: Repository<RegleDiplome>,
    private readonly anomalies: AnomaliesService,
    private readonly lotsReception: LotsReceptionService,
  ) {}

  async importer(contenu: Buffer): Promise<RapportImport> {
    const feuilles = await lireClasseur(contenu, ['NOMSETPRENOMS', 'DIPLOME']);
    if (!feuilles.length)
      throw new BadRequestException(
        "Aucune feuille visible avec les colonnes « Noms et prénoms » et « Diplôme » n'a été trouvée.",
      );

    const deps = new Map((await this.deps.find()).map((d) => [d.code, d]));
    const regles = new Map((await this.regles.find()).map((r) => [r.code, r]));
    const existants = new Map(
      (await this.agents.find()).map((a) => [a.cle, a]),
    );
    // Fiches saisies dans le système, retrouvées par nom + date de naissance
    const saisies = new Map(
      [...existants.values()]
        .filter((a) => a.origineFiche === 'SAISIE')
        .map((a) => [`${a.nomNormalise}|${a.dateNaissance}`, a]),
    );
    // Personnes à ranger dans les lots de réception (paquet = date de réception)
    const aRanger: { agent: Agent; groupe: number; date: string | null }[] = [];

    const rapport: RapportImport = {
      feuilles: feuilles.map((f) => ({ nom: f.nom, lignes: f.lignes.length })),
      lignesLues: 0,
      crees: 0,
      misAJour: 0,
      ignorees: 0,
      textesConserves: 0,
      affectationsCreees: 0,
      lots: [],
      anomalies: {},
      doublons: 0,
      textesPartages: 0,
    };
    const aSauver: Agent[] = [];
    const clesVues = new Set<string>();

    for (const f of feuilles) {
      const quotaAutres = cleCompacte(f.nom).includes('AUTRE');
      for (const l of f.lignes) {
        const nom = nettoyer(champ(l, 'NOMSETPRENOMS'));
        if (!nom) {
          rapport.ignorees++;
          continue;
        }
        rapport.lignesLues++;
        const data = this.lireLigne(l, quotaAutres, deps, regles);
        let cle = data.cle!;
        if (!existants.has(cle)) {
          const s = saisies.get(`${data.nomNormalise}|${data.dateNaissance}`);
          if (s && !clesVues.has(s.cle)) cle = s.cle;
        }
        if (clesVues.has(cle)) cle = `${cle}#${l._ligne}`;
        clesVues.add(cle);

        // N° de lot du fichier (ancienne numérotation) : sert seulement à regrouper les dates
        const lotNum = data.lotPublicationNumero;
        delete (data as { lotPublicationNumero?: unknown })
          .lotPublicationNumero;
        for (const a of data.anomalies ?? [])
          rapport.anomalies[a.split(' (')[0]] =
            (rapport.anomalies[a.split(' (')[0]] ?? 0) + 1;

        const ex = existants.get(cle);
        // Texte de la FP enregistré dans le système : le système fait foi
        if (ex?.textePointeLe) {
          data.typeTexte = ex.typeTexte;
          data.numeroTexte = ex.numeroTexte;
          data.dateReception = ex.dateReception;
          data.dateSignatureTexte = ex.dateSignatureTexte;
          rapport.textesConserves++;
        }
        if (ex?.transmissionNumero && !data.transmissionNumero)
          data.transmissionNumero = ex.transmissionNumero;
        // Dossier mis de côté (ou déjà corrigé) dans le système : le système fait foi
        if (ex?.misDeCoteLe) {
          data.transmissionNumero = ex.transmissionNumero;
          data.transmission = ex.transmission;
          for (const k of [
            'nomComplet',
            'dateNaissance',
            'lieuNaissance',
            'diplomeCode',
            'diplomeBrut',
            'departementId',
            'lotCommission',
          ] as const)
            (data as Record<string, unknown>)[k] = ex[k];
        }
        const avecTexte = !!ex?.textePointeLe || lotNum !== null;
        // Valeurs de la fiche avant la mise à jour : Object.assign écrit dans `ex` lui-même,
        // il faut donc les lire avant, sinon les corrections faites dans le système sont perdues
        const avant = ex
          ? {
              dateNaissance: ex.dateNaissance,
              departementId: ex.departementId,
              diplomeCode: ex.diplomeCode,
            }
          : null;
        const agent = Object.assign(ex ?? new Agent(), data, {
          cle,
          // Rangé plus bas dans le lot de son paquet, de son quota et de son type
          lotPublicationId: avecTexte ? (ex?.lotPublicationId ?? null) : null,
          // Valeurs saisies dans le système conservées si absentes du fichier
          dateSignatureTexte:
            data.dateSignatureTexte ?? ex?.dateSignatureTexte ?? null,
          contractuelForce: ex?.contractuelForce ?? null,
        });
        if (ex && avant) {
          // Une correction faite dans le système (date de naissance, département donné par la
          // répartition du quota « Autres », diplôme) n'est pas écrasée par une case vide du fichier
          if (!data.dateNaissance && avant.dateNaissance)
            agent.dateNaissance = avant.dateNaissance;
          // …ni par une date impossible du fichier (« 2018 » corrigé en « 1988 »)
          const aujourdhui = new Date().toISOString().slice(0, 10);
          if (
            data.dateNaissance &&
            avant.dateNaissance &&
            naissanceImprobable(data.dateNaissance, aujourdhui) &&
            !naissanceImprobable(avant.dateNaissance, aujourdhui)
          ) {
            agent.dateNaissance = avant.dateNaissance;
            data.anomalies = (data.anomalies ?? []).filter(
              (x) => !x.startsWith(NAISSANCE_IMPROBABLE),
            );
          }
          if (!data.departementId && avant.departementId)
            agent.departementId = avant.departementId;
          if (!data.diplomeCode && avant.diplomeCode)
            agent.diplomeCode = avant.diplomeCode;
          // Anomalies déjà corrigées ou vérifiées à la main : on ne les remet pas
          const verifiees = new Set(ex.anomaliesVerifiees ?? []);
          agent.anomaliesVerifiees = ex.anomaliesVerifiees ?? [];
          agent.anomalies = (data.anomalies ?? []).filter((x) => {
            if (verifiees.has(x.split(' (')[0])) return false;
            if (x.startsWith(NAISSANCE_IMPROBABLE)) return true;
            if (x.startsWith('Date de naissance')) return !agent.dateNaissance;
            if (x.startsWith('Département')) return !agent.departementId;
            if (x.startsWith('Diplôme')) return !agent.diplomeCode;
            return true;
          });
          rapport.misAJour++;
        } else rapport.crees++;
        // Les colonnes *Id font foi : on retire les relations chargées
        delete (agent as Partial<Agent>).lotPublication;
        delete (agent as Partial<Agent>).departement;
        aSauver.push(agent);
        // Texte enregistré dans le système : déjà rangé à la réception
        if (lotNum !== null && !ex?.textePointeLe)
          aRanger.push({ agent, groupe: lotNum, date: agent.dateReception });
      }
    }

    for (let i = 0; i < aSauver.length; i += 500)
      await this.agents.save(aSauver.slice(i, i + 500));

    // Rangement : paquet (date de réception, dates isolées rapprochées) puis lot
    const { items } = this.lotsReception.datesDePaquet(
      aRanger.map((x) => ({ id: x.agent.id, groupe: x.groupe, date: x.date })),
    );
    await this.lotsReception.ranger(items);
    await this.lotsReception.nettoyer();

    rapport.affectationsCreees = await this.creerAffectations(deps, regles);
    rapport.lots = await this.agents.query<
      { numero: number; libelle: string; agents: number }[]
    >(
      `SELECT l.numero, ${sqlLibelleLot('l')} AS libelle, count(*)::int AS agents
         FROM agent a JOIN lot_publication l ON l.id = a."lotPublicationId"
         GROUP BY l.id ORDER BY l.numero`,
    );
    const signalements = await this.signalerDoublons();
    rapport.doublons = signalements.doublons;
    rapport.textesPartages = signalements.textesPartages;
    for (const [k, n] of [
      ['Ressemble à une autre fiche', signalements.doublons],
      [TEXTE_PARTAGE, signalements.textesPartages],
    ] as const)
      if (n) rapport.anomalies[k] = n;
    await this.anomalies.reconcilier();
    return rapport;
  }

  /**
   * Après l'import, toute la base est comparée (pas seulement le fichier) :
   * - même personne enregistrée deux fois : « Ressemble à NOM (né(e) le …) », avec la même
   *   règle que la saisie (même date de naissance et nom concordant, ou nom complet repris) ;
   * - même n° de texte pour plusieurs personnes : « N° de texte partagé (6758, avec NOM) ».
   * Une anomalie déjà déclarée vérifiée n'est pas remise. Renvoie le nombre de fiches signalées.
   */
  async signalerDoublons(): Promise<{
    doublons: number;
    textesPartages: number;
  }> {
    const fiches = await this.agents.find({
      select: [
        'id',
        'nomComplet',
        'nomNormalise',
        'dateNaissance',
        'numeroTexte',
        'anomalies',
        'anomaliesVerifiees',
      ],
      loadEagerRelations: false,
    });
    const mots = new Map(fiches.map((f) => [f.id, motsDuNom(f.nomNormalise)]));
    const ajouts = new Map<string, Set<string>>();
    const ajouter = (id: string, anomalie: string) =>
      (ajouts.get(id) ?? ajouts.set(id, new Set()).get(id)!).add(anomalie);

    // Personnes : on ne compare que les fiches qui ont au moins un mot du nom en commun
    const parMot = new Map<string, number[]>();
    fiches.forEach((f, i) => {
      for (const m of new Set(mots.get(f.id)))
        (parMot.get(m) ?? parMot.set(m, []).get(m)!).push(i);
    });
    const vus = new Set<string>();
    const signalees = new Set<string>();
    for (const groupe of parMot.values())
      for (let x = 0; x < groupe.length; x++)
        for (let y = x + 1; y < groupe.length; y++) {
          const a = fiches[groupe[x]];
          const b = fiches[groupe[y]];
          const paire = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          if (vus.has(paire)) continue;
          vus.add(paire);
          if (
            ressemblance(
              mots.get(a.id)!,
              a.dateNaissance,
              mots.get(b.id)!,
              b.dateNaissance,
            ) !== 'PROBABLE'
          )
            continue;
          const libelle = (f: Agent) =>
            `${RESSEMBLE}${f.nomComplet}${f.dateNaissance ? ` (né(e) le ${dateFr(f.dateNaissance)})` : ''}`;
          ajouter(a.id, libelle(b));
          ajouter(b.id, libelle(a));
          signalees.add(a.id).add(b.id);
        }

    // Textes : même numéro pour plusieurs personnes
    const parTexte = new Map<string, Agent[]>();
    for (const f of fiches) {
      const k = cleTexte(f.numeroTexte);
      if (k) (parTexte.get(k) ?? parTexte.set(k, []).get(k)!).push(f);
    }
    let textesPartages = 0;
    for (const liste of parTexte.values()) {
      if (liste.length < 2) continue;
      for (const f of liste) {
        const autres = liste
          .filter((o) => o.id !== f.id)
          .map((o) => o.nomComplet);
        ajouter(
          f.id,
          `${TEXTE_PARTAGE} (${f.numeroTexte}, avec ${autres.slice(0, 2).join(', ')}${autres.length > 2 ? '…' : ''})`,
        );
        textesPartages++;
      }
    }

    // Écriture : seulement les fiches dont les anomalies changent
    const motif = (x: string) => x.split(' (')[0];
    for (const f of fiches) {
      const nouvelles = ajouts.get(f.id);
      if (!nouvelles) continue;
      const verifiees = new Set(f.anomaliesVerifiees ?? []);
      const actuelles = f.anomalies ?? [];
      const manquantes = [...nouvelles].filter(
        (x) => !actuelles.includes(x) && !verifiees.has(motif(x)),
      );
      if (manquantes.length)
        await this.agents.update(f.id, {
          anomalies: [...actuelles, ...manquantes],
        });
    }
    return { doublons: signalees.size, textesPartages };
  }

  private lireLigne(
    l: Ligne,
    quotaAutres: boolean,
    deps: Map<string, Departement>,
    regles: Map<string, RegleDiplome>,
  ): Partial<Agent> & { lotPublicationNumero: number | null } {
    const anomalies: string[] = [];
    const nomComplet = nettoyer(champ(l, 'NOMSETPRENOMS'))!;
    const nomNormalise = normaliser(nomComplet);

    const naissanceBrute = champ(l, 'DATEDENAIS');
    const dateNaissance = lireDate(naissanceBrute);
    if (!dateNaissance)
      anomalies.push(
        naissanceBrute
          ? 'Date de naissance illisible'
          : 'Date de naissance absente',
      );
    else if (
      naissanceImprobable(dateNaissance, new Date().toISOString().slice(0, 10))
    )
      anomalies.push(`${NAISSANCE_IMPROBABLE} (${dateFr(dateNaissance)})`);

    let departementBrut = nettoyer(champ(l, 'DEPARTEMENT', 'DEPART'));
    let source = nettoyer(champ(l, 'SOURCE'));
    // Colonnes Département / Source inversées dans certaines lignes
    if (cleCompacte(departementBrut) === 'MEPPSA' && codeDepartement(source)) {
      [departementBrut, source] = [source, departementBrut];
      anomalies.push('Colonnes Département/Source inversées (corrigé)');
    }
    const codeDep = codeDepartement(departementBrut);
    if (!codeDep)
      anomalies.push(
        departementBrut ? 'Département non reconnu' : 'Département absent',
      );

    const diplomeBrut = nettoyer(champ(l, 'DIPLOME'));
    const diplomeCode = reconnaitreDiplome(diplomeBrut, [...regles.values()]);
    if (!diplomeCode) anomalies.push('Diplôme non reconnu');

    const cycleBrut = nettoyer(champ(l, 'CYCLE'));
    const regle = diplomeCode ? regles.get(diplomeCode) : undefined;
    const cb = codeCycle(cycleBrut);
    if (regle && cb && cb !== regle.cycle)
      anomalies.push('Cycle de la base différent de celui du diplôme');

    const lotBrut = nettoyer(champ(l, 'LOTDEPUBLICAT', 'LOTDEPUBLICATION'));
    const lotPublicationNumero = lotBrut ? romainVersEntier(lotBrut) : null;
    if (lotBrut && lotPublicationNumero === null)
      anomalies.push(`Lot de publication invalide (${lotBrut})`);

    const tt = typeTexte(champ(l, 'TYPEDETEXTE'));
    const numeroTexte = nettoyer(champ(l, 'NTEXTE', 'NDUTEXTE'));
    const receptionBrute = champ(l, 'DATEDERECEPTION');
    if (
      cleCompacte(receptionBrute) === 'DOUBLON' ||
      cleCompacte(lotBrut) === 'DOUBLON'
    )
      anomalies.push('Signalé comme doublon dans la base');
    if (lotPublicationNumero !== null && !numeroTexte)
      anomalies.push('Lot de publication sans numéro de texte');

    const quota = entier(champ(l, 'QUOTA'));
    const numeroOrdre = entier(champ(l, 'NDORDRE'));
    const cle = quotaAutres
      ? `QA|${nomNormalise}|${dateNaissance ?? normaliser(naissanceBrute)}`
      : `M|${quota ?? ''}|${numeroOrdre ?? ''}|${nomNormalise}`;

    return {
      cle,
      feuille: quotaAutres ? 'QUOTA_AUTRES' : 'MEPPSA',
      quota,
      numeroOrdre,
      numeroListe: entier(champ(l, 'NLISTE')),
      nomComplet,
      nomNormalise,
      dateNaissance,
      dateNaissanceBrute:
        naissanceBrute instanceof Date ? null : nettoyer(naissanceBrute),
      lieuNaissance: nettoyer(champ(l, 'LIEUDENAIS')),
      diplomeBrut,
      diplomeCode,
      departementBrut,
      departementId: codeDep ? deps.get(codeDep)!.id : null,
      source,
      cycleBrut,
      lotCommission: lotCommission(champ(l, 'LOT')),
      statut: nettoyer(champ(l, 'STATUT')),
      transmission: nettoyer(champ(l, 'TRANSMISSION')),
      transmissionNumero: entier(
        nettoyer(champ(l, 'TRANSMISSION'))?.match(/^\d+/)?.[0],
      ),
      parapheur: nettoyer(champ(l, 'NPARAPHEUR')),
      lieuServiceBrut: nettoyer(champ(l, 'LIEUDESERVICE')),
      origineBrute: nettoyer(champ(l, 'ORIGINE')),
      observation: nettoyer(champ(l, 'OBS', 'OBSERVATION')),
      typeTexte: tt,
      numeroTexte,
      dateSignatureTexte: lireDate(
        champ(l, 'DATEDESIGNATURE', 'DATESIGNATURE'),
      ),
      dateReception: lireDate(receptionBrute),
      lotPublicationNumero,
      anomalies,
    };
  }

  /** Crée l'affectation par défaut de chaque agent dont le texte est reçu. */
  async creerAffectations(
    deps?: Map<string, Departement>,
    regles?: Map<string, RegleDiplome>,
  ): Promise<number> {
    deps ??= new Map((await this.deps.find()).map((d) => [d.code, d]));
    regles ??= new Map((await this.regles.find()).map((r) => [r.code, r]));
    const depsParId = new Map([...deps.values()].map((d) => [d.id, d]));

    // Lot modifié dans le fichier pour une affectation pas encore dans une note
    await this.affectations.query(`
      UPDATE affectation f SET "lotPublicationId" = a."lotPublicationId"
      FROM agent a WHERE a.id = f."agentId" AND a."lotPublicationId" IS NOT NULL
        AND a."lotPublicationId" <> f."lotPublicationId" AND f.statut = 'A_TRAITER'`);

    const sans = await this.agents.find({
      where: { lotPublicationId: Not(IsNull()) },
      select: ['id', 'diplomeCode', 'departementId', 'lotPublicationId'],
      loadEagerRelations: false,
    });
    const avec = new Set(
      (
        await this.affectations.find({
          select: ['agentId'],
          loadEagerRelations: false,
        })
      ).map((a) => a.agentId),
    );
    const nouvelles = sans
      .filter((a) => !avec.has(a.id))
      .map((a) => {
        const regle = a.diplomeCode ? regles.get(a.diplomeCode) : undefined;
        const typeNote = regle?.typeNote ?? 'A_DEFINIR';
        const dep = a.departementId
          ? depsParId.get(a.departementId)
          : undefined;
        return this.affectations.create({
          agentId: a.id,
          lotPublicationId: a.lotPublicationId!,
          typeNote,
          departementId: a.departementId,
          structure:
            typeNote === 'PERS_ADM' && dep ? `DDEPPSA ${dep.nom}` : null,
          statut: 'A_TRAITER',
        });
      });
    for (let i = 0; i < nouvelles.length; i += 500)
      await this.affectations.insert(nouvelles.slice(i, i + 500));
    return nouvelles.length;
  }
}
