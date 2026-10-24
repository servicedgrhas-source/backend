import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommunautairesVaguesRecommandations1792787418777 implements MigrationInterface {
  name = 'CommunautairesVaguesRecommandations1792787418777';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f92cbae62a95024277ad4cc727"`,
    );
    await queryRunner.query(`ALTER TABLE "agent" ADD "agentRecenseId" integer`);
    await queryRunner.query(`ALTER TABLE "agent" ADD "vagueNumero" integer`);
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD "operation" character varying NOT NULL DEFAULT 'AFFECTATION'`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD "demandeId" uuid`,
    );
    await queryRunner.query(`ALTER TABLE "recommandation" ADD "enroleId" uuid`);
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD "personne" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD "etape" character varying NOT NULL DEFAULT 'DECISION_DG'`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD "avisDirecteur" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "volontaire" ADD "population" character varying NOT NULL DEFAULT 'VOLONTAIRE'`,
    );
    await queryRunner.query(
      `ALTER TABLE "volontaire" ADD "vagueNumero" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "etat_bourse" ADD "population" character varying NOT NULL DEFAULT 'VOLONTAIRE'`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP CONSTRAINT "FK_f51071657dc1f5168e199aa1a49"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" ALTER COLUMN "affectationId" DROP NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bd29929863b429d233635497d8" ON "agent" ("agentRecenseId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6a39e782cddcecf7c4a3d9dc80" ON "recommandation" ("operation") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_84678d9e84601c97e18e78d15b" ON "recommandation" ("demandeId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_de714cad2f4d9e1a861503a65c" ON "recommandation" ("enroleId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b5f523e249dd2e2dbd986e2935" ON "volontaire" ("population") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_d9e7f5cd9457bab780ae948cdd" ON "etat_bourse" ("mois", "population") `,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD CONSTRAINT "FK_f51071657dc1f5168e199aa1a49" FOREIGN KEY ("affectationId") REFERENCES "affectation"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP CONSTRAINT "FK_f51071657dc1f5168e199aa1a49"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d9e7f5cd9457bab780ae948cdd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b5f523e249dd2e2dbd986e2935"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_de714cad2f4d9e1a861503a65c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_84678d9e84601c97e18e78d15b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6a39e782cddcecf7c4a3d9dc80"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bd29929863b429d233635497d8"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" ALTER COLUMN "affectationId" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD CONSTRAINT "FK_f51071657dc1f5168e199aa1a49" FOREIGN KEY ("affectationId") REFERENCES "affectation"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "etat_bourse" DROP COLUMN "population"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volontaire" DROP COLUMN "vagueNumero"`,
    );
    await queryRunner.query(
      `ALTER TABLE "volontaire" DROP COLUMN "population"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP COLUMN "avisDirecteur"`,
    );
    await queryRunner.query(`ALTER TABLE "recommandation" DROP COLUMN "etape"`);
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP COLUMN "personne"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP COLUMN "enroleId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP COLUMN "demandeId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP COLUMN "operation"`,
    );
    await queryRunner.query(`ALTER TABLE "agent" DROP COLUMN "vagueNumero"`);
    await queryRunner.query(`ALTER TABLE "agent" DROP COLUMN "agentRecenseId"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_f92cbae62a95024277ad4cc727" ON "etat_bourse" ("mois") `,
    );
  }
}
