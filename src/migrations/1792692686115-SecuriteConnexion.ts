import { MigrationInterface, QueryRunner } from 'typeorm';

export class SecuriteConnexion1792692686115 implements MigrationInterface {
  name = 'SecuriteConnexion1792692686115';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "utilisateur" ADD "versionSession" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "utilisateur" ADD "echecsConnexion" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "utilisateur" ADD "dernierEchec" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "utilisateur" ADD "bloqueJusqua" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "utilisateur" DROP COLUMN "bloqueJusqua"`,
    );
    await queryRunner.query(
      `ALTER TABLE "utilisateur" DROP COLUMN "dernierEchec"`,
    );
    await queryRunner.query(
      `ALTER TABLE "utilisateur" DROP COLUMN "echecsConnexion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "utilisateur" DROP COLUMN "versionSession"`,
    );
  }
}
