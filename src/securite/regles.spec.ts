import {
  classer,
  estPiege,
  etatVide,
  type Gain,
  observerAppel,
  observerReponse,
  parametresImpossibles,
  REGLES,
  regleNavigateur,
  scoreDecru,
} from './regles';

const T0 = Date.UTC(2026, 10, 9, 9, 0, 0); // lundi 10 h à Brazzaville
const navigateur =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const points = (g: Gain[]) => g.reduce((s, x) => s + REGLES[x.regle].points, 0);

function appel(
  e: ReturnType<typeof etatVide>,
  t: number,
  chemin: string,
  o: {
    query?: Record<string, unknown>;
    interactions?: number;
    visible?: boolean;
    ua?: string;
    ip?: string;
  } = {},
) {
  return observerAppel(e, {
    t,
    classe: classer(`/api/${chemin}`, 'GET'),
    query: o.query ?? {},
    ip: o.ip ?? '10.0.0.1',
    ua: o.ua ?? navigateur,
    session: 's1',
    contexte: {
      page: '/personnel/agents',
      interactions: o.interactions ?? 1,
      visible: o.visible ?? true,
    },
  });
}

describe('Outil de détection : règles', () => {
  it('classe les adresses : lectures communes, fiches, exports', () => {
    expect(classer('/api/menu/compteurs', 'GET').commune).toBe(true);
    expect(classer('/api/notes/abc/word', 'GET').commune).toBe(true);
    expect(classer('/api/recensement/agents/42', 'GET').fiche).toEqual({
      type: 'agent',
      id: '42',
    });
    expect(classer('/api/recensement/export', 'GET').export).toBe(true);
    expect(classer('/api/mutations/excel', 'GET').export).toBe(true);
    expect(classer('/api/recensement/agents/42', 'PUT').fiche).toBeNull();
  });

  it('pas de fiche là où il n’y en a pas (faux positifs du 08/11/2026)', () => {
    for (const c of [
      'demandes-prestation/catalogue',
      'enrolement/volontaires/ecarts',
      'enrolement/volontaires/export',
      'dossiers/recherche',
    ])
      expect(classer(`/api/${c}`, 'GET').fiche).toBeNull();
    const e = etatVide(T0);
    appel(e, T0, 'mutations', { ip: '::1' });
    expect(
      appel(e, T0 + 1000, 'mutations', { ip: '' }).map((x) => x.regle),
    ).not.toContain('E2_CHANGEMENT');
  });

  it('reconnaît un navigateur, un outil, un autre site', () => {
    const ok = (o: string) => o === 'https://www.dgrhas.com';
    expect(
      regleNavigateur(
        { secFetchSite: 'same-origin', userAgent: navigateur },
        ok,
      ),
    ).toEqual([]);
    expect(
      regleNavigateur(
        {
          origin: 'https://www.dgrhas.com',
          secFetchSite: 'cross-site',
          userAgent: navigateur,
        },
        ok,
      ),
    ).toEqual([]);
    // Ancien Safari sans Sec-Fetch : l'origine suffit
    expect(
      regleNavigateur(
        { origin: 'https://www.dgrhas.com', userAgent: navigateur },
        ok,
      ),
    ).toEqual([]);
    expect(
      regleNavigateur({ userAgent: 'curl/8.4.0' }, ok).map((g) => g.regle),
    ).toEqual(['A1_HORS_NAVIGATEUR', 'A2_OUTIL']);
    expect(
      regleNavigateur(
        {
          origin: 'https://pirate.example',
          secFetchSite: 'cross-site',
          userAgent: navigateur,
        },
        ok,
      ).map((g) => g.regle),
    ).toEqual(['A1_AUTRE_SITE']);
    expect(
      regleNavigateur(
        { secFetchSite: 'same-origin', userAgent: 'python-requests/2.31' },
        ok,
      ).map((g) => g.regle),
    ).toEqual(['A2_OUTIL']);
  });

  it('paramètres impossibles : inconnus ou tailles démesurées', () => {
    expect(
      parametresImpossibles({ motif: 'X' }, new Set(['motif', 'etat'])),
    ).toEqual([]);
    expect(
      parametresImpossibles({ tout: '1' }, new Set(['motif'])),
    ).toHaveLength(1);
    expect(parametresImpossibles({ taille: '5000' }, null)).toHaveLength(1);
    expect(parametresImpossibles({ taille: '50' }, null)).toEqual([]);
  });

  it('adresses pièges', () => {
    expect(estPiege('/api/admin/dump')).toBe(true);
    expect(estPiege('/api/agents/export-complet')).toBe(true);
    expect(estPiege('/api/recensement/agents/12')).toBe(false);
  });

  it('une journée de travail humaine ne rapporte aucun point', () => {
    const e = etatVide(T0);
    let t = T0;
    let total = 0;
    // 3 heures : une page toutes les 5 à 40 s (12 appels groupés), des fiches ouvertes au fil du travail,
    // une pause de 5 minutes toutes les 40 minutes, quelques exports
    let fiche = 100;
    for (let i = 0; i < 400; i++) {
      t += 5_000 + ((i * 7919) % 35_000);
      if (i % 60 === 59) t += 5 * 60_000;
      for (let k = 0; k < 12; k++)
        total += points(
          appel(
            e,
            t + k * 40,
            k % 3 ? 'recensement/agents' : 'menu/compteurs',
            { query: { page: 1 } },
          ),
        );
      if (i % 3 === 0)
        total += points(
          appel(e, t + 600, `recensement/agents/${(fiche += 37)}`),
        );
      if (i % 50 === 0)
        total += points(appel(e, t + 800, 'recensement/export'));
    }
    expect(total).toBe(0);
  });

  it('un programme qui parcourt les fiches est repéré', () => {
    const e = etatVide(T0);
    const g: Gain[] = [];
    for (let i = 1; i <= 40; i++)
      g.push(
        ...appel(e, T0 + i * 1500, `recensement/agents/${i}`, {
          interactions: 0,
        }),
      );
    const regles = new Set(g.map((x) => x.regle));
    expect(regles.has('C3_PARCOURS')).toBe(true);
    expect(regles.has('C2_FICHES_MINUTE')).toBe(true);
  });

  it('pages d’une liste à la suite, rafale, régularité de machine', () => {
    const e = etatVide(T0);
    const g: Gain[] = [];
    for (let p = 1; p <= 10; p++)
      g.push(
        ...appel(e, T0 + p * 2000, 'recensement/agents', {
          query: { page: p },
        }),
      );
    expect(g.map((x) => x.regle)).toContain('C3_PARCOURS');
    const e2 = etatVide(T0);
    const g2: Gain[] = [];
    for (let i = 0; i < 300; i++)
      g2.push(...appel(e2, T0 + i * 150, 'mutations'));
    expect(g2.map((x) => x.regle)).toContain('C1_RAFALE');
    const e3 = etatVide(T0);
    const g3: Gain[] = [];
    for (let i = 0; i < 30; i++)
      g3.push(...appel(e3, T0 + i * 3000, 'mutations'));
    expect(g3.map((x) => x.regle)).toContain('C7_REGULARITE');
  });

  it('personne derrière l’écran, onglet caché, deux navigateurs', () => {
    const e = etatVide(T0);
    appel(e, T0, 'mutations');
    const g = appel(e, T0 + 6 * 60_000, 'recensement/agents/7', {
      interactions: 0,
      visible: false,
    });
    expect(g.map((x) => x.regle).sort()).toEqual([
      'D1_SANS_ACTIVITE',
      'D2_ONGLET_CACHE',
    ]);
    const g2 = appel(e, T0 + 6 * 60_000 + 500, 'mutations', { ua: 'curl/8' });
    expect(g2.map((x) => x.regle)).toContain('E1_DEUX_NAVIGATEURS');
  });

  it('refus et fiches inexistantes en série', () => {
    const e = etatVide(T0);
    let g: Gain[] = [];
    for (let i = 0; i < 7; i++)
      g = g.concat(
        observerReponse(e, T0 + i, classer('/api/utilisateurs', 'GET'), 403),
      );
    expect(g.filter((x) => x.regle === 'A6_REFUS')).toHaveLength(2);
    let h: Gain[] = [];
    for (let i = 0; i < 7; i++)
      h = h.concat(
        observerReponse(
          e,
          T0 + i,
          classer(`/api/recensement/agents/${900000 + i}`, 'GET'),
          404,
        ),
      );
    expect(h.map((x) => x.regle)).toContain('B2_INTROUVABLES');
  });

  it('le score redescend de moitié à chaque demi-vie', () => {
    expect(scoreDecru(80, 30 * 60_000, 30)).toBeCloseTo(40);
  });
});
