import { CATALOGUE } from '../circuit/catalogue';
import { PRESTATIONS, type DefinitionPrestation } from './definitions';
import { rendre, reperesDe, valeurRepere, type ContexteActe } from './moteur';

/** Demande fictive où tous les renseignements de la prestation sont remplis. */
function contexte(def: DefinitionPrestation, genre: 'M' | 'F'): ContexteActe {
  const details: Record<string, unknown> = {};
  for (const c of def.champs) {
    if (c.type === 'departement') {
      details[c.cle] = 1;
      details[`${c.cle}Nom`] = 'Bouenza';
    } else if (c.type === 'liste') {
      details[c.cle] = c.options![0].valeur;
      details[`${c.cle}Libelle`] = c.options![0].libelle;
    } else if (c.type === 'date') details[c.cle] = '2026-11-02';
    else details[c.cle] = `Valeur ${c.cle}`;
  }
  return {
    agent: {
      genre,
      nomComplet: 'ZZTESTFICTIF Agent',
      grade: 'Instituteur',
      categorie: 'II',
      echelle: '1',
      echelon: '3',
      matricule: '123456X',
      lieuService: 'École fictive',
      departement: 'Pool',
    },
    details,
    champs: def.champs,
    param: (cle) => `Paramètre ${cle}`,
    decideur: {
      sigle: 'EP ZZ',
      nom: 'École primaire ZZ fictive',
      poste: 'Directeur d’école',
    },
  };
}

describe('Définitions des demandes de prestations (moteur)', () => {
  it.each(PRESTATIONS.map((p) => [p.code, p] as const))(
    '%s : définition complète',
    (_code, def) => {
      // Même code que le catalogue (le circuit vient de là)
      expect(CATALOGUE.some((t) => t.code === def.code)).toBe(true);
      // La première pièce est indispensable (la demande manuscrite, sauf le n° 41 sans demande)
      expect(def.pieces[0].obligatoire).toBe(true);
      if (!['PROMOTION_APTITUDE', 'RECTIFICATIF_IDENTITE'].includes(def.code))
        expect(def.pieces[0].libelle).toMatch(/Demande manuscrite/);
      // Une lettre a son destinataire, son objet et sa formule d'appel
      expect(!!def.acteModele.lettre).toBe(def.acteModele.forme === 'LETTRE');
      expect(new Set(def.champs.map((c) => c.cle)).size).toBe(
        def.champs.length,
      );
      for (const c of def.champs)
        if (c.type === 'liste') expect(c.options?.length).toBeGreaterThan(0);
      expect(def.acteModele.articles.length).toBeGreaterThan(0);
    },
  );

  it.each(PRESTATIONS.map((p) => [p.code, p] as const))(
    '%s : le modèle de l’acte s’écrit sans repère inconnu ni trou',
    (_code, def) => {
      const m = def.acteModele;
      const textes = [
        m.titre,
        def.signataire,
        ...m.preambule,
        ...m.articles,
        ...m.ampliations,
        ...Object.values(m.lettre ?? {}),
      ];
      for (const genre of ['M', 'F'] as const) {
        const ctx = contexte(def, genre);
        for (const t of textes) {
          for (const r of reperesDe(t))
            expect(() => valeurRepere(r, ctx)).not.toThrow();
          const ecrit = rendre(t, ctx);
          expect(ecrit).not.toMatch(/[{}[\]]|…/);
        }
      }
    },
  );

  it('accorde au féminin et retire les morceaux facultatifs vides', () => {
    const def = PRESTATIONS.find((p) => p.code === 'AFFECTATION_NATIONALE')!;
    const ctx = contexte(def, 'F');
    delete ctx.details.lieuSouhaite;
    const [art1, art2] = def.acteModele.articles.map((t) => rendre(t, ctx));
    expect(art1).toMatch(
      /^Madame ZZTESTFICTIF Agent, Instituteur, catégorie II, échelle 1, 3e échelon, matricule 123456X, en service à École fictive, est affectée à la Direction départementale .* de Bouenza \(préscolaire\)\.$/,
    );
    expect(art2).toBe('Le Directeur départemental lui assigne son poste.');
  });

  it('écrit « … » pour un renseignement obligatoire absent (à compléter)', () => {
    const def = PRESTATIONS.find((p) => p.code === 'NOMINATION_CHEFS')!;
    const ctx = contexte(def, 'M');
    delete ctx.details.intitule;
    expect(rendre(def.acteModele.articles[0], ctx)).toContain(
      'chef de service : …,',
    );
  });

  it('refuse un repère inconnu (faute dans une définition)', () => {
    const ctx = contexte(PRESTATIONS[0], 'M');
    expect(() => rendre('{champ:nexistepas}', ctx)).toThrow(/Repère inconnu/);
    expect(() => rendre('{bizarre}', ctx)).toThrow(/Repère inconnu/);
  });

  it('n° du document de la DGRHAS : ceux du catalogue, dans l’ordre, codes uniques', () => {
    // Le document numérote deux prestations « 40 » : la seconde est rangée au n° 42 du catalogue
    const numeros = PRESTATIONS.map((p) => p.numero);
    expect(numeros).toEqual([...numeros].sort((a, b) => a - b));
    expect(new Set(PRESTATIONS.map((p) => p.code)).size).toBe(
      PRESTATIONS.length,
    );
    for (const p of PRESTATIONS)
      expect(CATALOGUE.find((t) => t.code === p.code)?.numero).toBe(p.numero);
  });

  it('tout le document : chaque prestation du catalogue (hors mutations) a sa définition', () => {
    const mutations = (code: string) => /^(MUTATION|PERMUTATION)/.test(code);
    expect(
      CATALOGUE.filter(
        (t) =>
          !mutations(t.code) && !PRESTATIONS.some((p) => p.code === t.code),
      ).map((t) => t.code),
    ).toEqual([]);
  });

  it('contrôle de l’ordre des dates : sur des champs de date existants', () => {
    for (const p of PRESTATIONS)
      for (const o of p.ordreDates ?? [])
        for (const cle of [o.avant, o.apres])
          expect(p.champs.find((c) => c.cle === cle)?.type).toBe('date');
  });

  it('acte et circuit d’accord : le lieu de service signe ce qu’il décide', () => {
    for (const p of PRESTATIONS) {
      const t = CATALOGUE.find((x) => x.code === p.code)!;
      expect(p.acte.startsWith(t.acte)).toBe(true);
      expect(p.niveauDecision === 'Lieu de service').toBe(
        t.decision === 'LIEU_SERVICE',
      );
      if (t.decision === 'LIEU_SERVICE') {
        expect(p.signataire).toContain('{decideur.poste}');
        expect(p.acteModele.entete).toBe('STRUCTURE');
      }
      // Un certificat ou une attestation n'a pas d'articles numérotés ni de « DÉCIDE »
      if (/^(Certificat|Attestation)$/.test(p.acte))
        expect([p.acteModele.forme, p.acteModele.formule]).toEqual([
          'TEXTE',
          null,
        ]);
    }
  });

  it('certificat de reprise après congé : signé par le responsable du lieu', () => {
    const def = PRESTATIONS.find((p) => p.code === 'REPRISE_CONGE')!;
    const ctx = contexte(def, 'M');
    expect(rendre(def.acteModele.articles[0], ctx)).toBe(
      'Je soussigné(e), directeur d’école (École primaire ZZ fictive), certifie que Monsieur ZZTESTFICTIF Agent, Instituteur, catégorie II, échelle 1, 3e échelon, matricule 123456X, en congé administratif du 02/11/2026 au 02/11/2026, a repris service à École primaire ZZ fictive le 02/11/2026.',
    );
    expect(rendre(def.signataire, ctx)).toBe('Le directeur d’école');
  });

  it('désertion : « absente » au féminin, note de réutilisation facultative', () => {
    const def = PRESTATIONS.find((p) => p.code === 'REPRISE_DESERTION')!;
    const ctx = contexte(def, 'F');
    delete ctx.details.noteReutilisation;
    const t = rendre(def.acteModele.articles[0], ctx);
    expect(t).toContain('absente de son poste depuis le 02/11/2026');
    expect(t).not.toContain('réutilisation');
  });

  it('décret : directrice au féminin', () => {
    const def = PRESTATIONS.find((p) => p.code === 'NOMINATION_DIRECTEURS')!;
    expect(rendre(def.acteModele.articles[0], contexte(def, 'F'))).toMatch(
      /est nommée directrice départementale : Valeur direction\.$/,
    );
  });
});
