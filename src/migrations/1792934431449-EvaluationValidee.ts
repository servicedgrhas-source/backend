import { MigrationInterface, QueryRunner } from 'typeorm';

export class EvaluationValidee1792934431449 implements MigrationInterface {
  name = 'EvaluationValidee1792934431449';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evaluation_agent" ADD "valideeLe" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "evaluation_agent" ADD "valideePar" character varying`,
    );
    // Les évaluations d'avant la validation étaient définitives : validées par leur évaluateur,
    // à la date de leur dernier enregistrement
    await queryRunner.query(
      `UPDATE "evaluation_agent" SET "valideeLe" = COALESCE("modifieLe", "creeLe"), "valideePar" = "evaluateur"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "evaluation_agent" DROP COLUMN "valideePar"`,
    );
    await queryRunner.query(
      `ALTER TABLE "evaluation_agent" DROP COLUMN "valideeLe"`,
    );
  }
}
