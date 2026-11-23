import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Types de bâtiments et de salles (23/11/2026) : l'ancien système n'en donnait que 4 et 9 ; sur le
 * terrain on trouve aussi les logements, cantines, latrines, magasins, paillotes… Ajoutés (source
 * SAISIE), sans toucher aux existants ; la DGRHAS les corrige ou les désactive dans Référentiels.
 */
const BATIMENTS = [
  'Bâtiment mixte (classes et bureaux)',
  'Logement',
  'Cantine / Réfectoire',
  'Cuisine',
  'Latrines',
  'Magasin',
  'Bibliothèque',
  'Atelier',
  'Laboratoire',
  'Infirmerie',
  'Internat / Dortoir',
  'Salle polyvalente',
  'Préau / Hangar',
  'Abri provisoire (paillote)',
  'Guérite',
];
const SALLES = [
  'Bureau du chef d’établissement',
  'Salle des professeurs',
  'Salle de réunion',
  'Salle informatique',
  'Salle polyvalente',
  'Salle d’études',
  'Atelier',
  'Infirmerie',
  'Magasin',
  'Archives',
  'Cantine / Réfectoire',
  'Cuisine',
  'Dortoir',
  'Logement',
  'Latrines',
  'Classe sous abri provisoire (paillote)',
];

// (comme normaliser() et cleCompacte() de common/texte)
const normalise = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
const code = (s: string) => normalise(s).replace(/[^A-Z0-9]/g, '');

export class TypesBatimentsSalles1793800000000 implements MigrationInterface {
  name = 'TypesBatimentsSalles1793800000000';

  public async up(q: QueryRunner): Promise<void> {
    for (const [type, liste] of [
      ['TYPE_BATIMENT', BATIMENTS],
      ['TYPE_SALLE', SALLES],
    ] as const)
      for (const [i, libelle] of liste.entries())
        await q.query(
          `INSERT INTO referentiel (type, code, libelle, "libelleNormalise", actif, ordre, source, donnees)
           SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar, true, $5::int, 'SAISIE', '{}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM referentiel
                               WHERE type = $1::varchar
                                 AND (code = $2::varchar OR "libelleNormalise" = $4::varchar))`,
          [type, code(libelle), libelle, normalise(libelle), 100 + i],
        );
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const [type, liste] of [
      ['TYPE_BATIMENT', BATIMENTS],
      ['TYPE_SALLE', SALLES],
    ] as const)
      await q.query(
        `DELETE FROM referentiel WHERE type = $1 AND source = 'SAISIE' AND code = ANY($2)`,
        [type, liste.map(code)],
      );
  }
}
