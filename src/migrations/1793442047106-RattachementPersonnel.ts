import { MigrationInterface, QueryRunner } from "typeorm";

export class RattachementPersonnel1793442047106 implements MigrationInterface {
    name = 'RattachementPersonnel1793442047106'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "demande_mutation" ADD "rattachement" character varying`);
        await queryRunner.query(`ALTER TABLE "nomination" ADD "rattachement" character varying`);
        await queryRunner.query(`CREATE INDEX "IDX_f4b8f8b7547817a921131c76bc" ON "demande_mutation" ("rattachement") `);
        await queryRunner.query(`CREATE INDEX "IDX_996966988ce3ba5732a7e6fd56" ON "nomination" ("rattachement") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_996966988ce3ba5732a7e6fd56"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f4b8f8b7547817a921131c76bc"`);
        await queryRunner.query(`ALTER TABLE "nomination" DROP COLUMN "rattachement"`);
        await queryRunner.query(`ALTER TABLE "demande_mutation" DROP COLUMN "rattachement"`);
    }

}
