import { MigrationInterface, QueryRunner } from "typeorm";

export class LotsDuFichier1793382469283 implements MigrationInterface {
    name = 'LotsDuFichier1793382469283'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "lot_publication" ADD "numeroFichier" integer`);
        await queryRunner.query(`ALTER TABLE "lot_publication" ADD "archive" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "agent" ADD "qualification" character varying`);
        await queryRunner.query(`ALTER TABLE "agent" ADD "specialite" character varying`);
        await queryRunner.query(`ALTER TABLE "affectation" ADD "deporteLe" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "affectation" ADD "deportePar" character varying`);
        await queryRunner.query(`ALTER TABLE "note_service" ADD "groupes" jsonb NOT NULL DEFAULT '[]'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "note_service" DROP COLUMN "groupes"`);
        await queryRunner.query(`ALTER TABLE "affectation" DROP COLUMN "deportePar"`);
        await queryRunner.query(`ALTER TABLE "affectation" DROP COLUMN "deporteLe"`);
        await queryRunner.query(`ALTER TABLE "agent" DROP COLUMN "specialite"`);
        await queryRunner.query(`ALTER TABLE "agent" DROP COLUMN "qualification"`);
        await queryRunner.query(`ALTER TABLE "lot_publication" DROP COLUMN "archive"`);
        await queryRunner.query(`ALTER TABLE "lot_publication" DROP COLUMN "numeroFichier"`);
    }

}
