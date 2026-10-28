import { MigrationInterface, QueryRunner } from 'typeorm';

/** Nominations des cadres de gestion des établissements et des inspections (DGRHAS, 26/10/2026). */
export class Nominations1792965000000 implements MigrationInterface {
  name = 'Nominations1792965000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "nomination" ("id" SERIAL NOT NULL, "annee" character varying NOT NULL, "categorie" character varying NOT NULL, "departementId" integer, "circonscription" character varying, "agentId" integer, "nomComplet" character varying NOT NULL, "nomNormalise" character varying NOT NULL, "genre" character varying, "grade" character varying, "echelon" character varying, "categorieAgent" character varying, "echelle" character varying, "specialite" character varying, "vague" character varying, "ancienPoste" character varying, "nouveauPoste" character varying, "observation" character varying NOT NULL DEFAULT 'RECONDUIT', "motif" text, "statut" character varying NOT NULL DEFAULT 'PROPOSEE', "avisDdeppsa" text, "avisDgrhas" text, "decidePar" character varying, "decideLe" TIMESTAMP WITH TIME ZONE, "modifie" boolean NOT NULL DEFAULT false, "origineId" integer, "noteId" uuid, "source" character varying NOT NULL DEFAULT 'SAISIE', "creePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_nomination" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_694ec1cc8153655dfce5463362" ON "nomination" ("annee", "categorie")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3244be0887d0e5b3588a88107c" ON "nomination" ("annee")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_185b0cda87230c43a61b5f1f6c" ON "nomination" ("departementId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bbcbf7f14f3689b38b76539649" ON "nomination" ("agentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_847c3bd3a61c08e1d916c98abb" ON "nomination" ("nomNormalise")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8dbc97edce1044a3f6d8fd2bd8" ON "nomination" ("statut")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f410c5dc3c848b9987b6bfed17" ON "nomination" ("noteId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "nomination"`);
  }
}
