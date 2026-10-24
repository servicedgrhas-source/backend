import { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1792683830994 implements MigrationInterface {
  name = 'Initial1792683830994';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "utilisateur" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "email" character varying NOT NULL, "nom" character varying NOT NULL, "initiales" character varying(10), "role" character varying NOT NULL, "departementId" integer, "structureId" integer, "delegueId" uuid, "delegationFin" date, "motDePasseHash" character varying NOT NULL, "codeChiffre" character varying, "codeCreeLe" TIMESTAMP WITH TIME ZONE, "actif" boolean NOT NULL DEFAULT true, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_838f0f99fe900e49ef050030443" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_e1136325a6b28e2a02b81b2f5e" ON "utilisateur" ("email") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_00b3578632111a051d146113c4" ON "utilisateur" ("structureId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "journal" ("id" SERIAL NOT NULL, "date" TIMESTAMP NOT NULL DEFAULT now(), "utilisateurId" uuid, "utilisateurNom" character varying, "action" character varying NOT NULL, "entite" character varying, "entiteId" character varying, "details" jsonb, CONSTRAINT "PK_396f862c229742e29f888b1abce" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b8b64f4ab7601a8ba0ae2b636c" ON "journal" ("date") `,
    );
    await queryRunner.query(
      `CREATE TABLE "parametre" ("cle" character varying NOT NULL, "valeur" text NOT NULL, "description" character varying, CONSTRAINT "PK_38f6e0e2817443560f5f90720e9" PRIMARY KEY ("cle"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "departement" ("id" SERIAL NOT NULL, "code" character varying NOT NULL, "nom" character varying NOT NULL, "article" character varying NOT NULL, "ordre" integer NOT NULL, CONSTRAINT "PK_f32f7be16ef46566fececc35a34" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ada6d1fc4f9bf4122ecb2966c7" ON "departement" ("code") `,
    );
    await queryRunner.query(
      `CREATE TABLE "regle_diplome" ("code" character varying NOT NULL, "libelle" character varying NOT NULL, "cycle" character varying NOT NULL, "typeNote" character varying NOT NULL, "gradeCode" character varying, "ecritures" jsonb NOT NULL DEFAULT '[]', "grade" character varying, "gradeLibelle" character varying, "categorie" character varying, "echelle" integer, "echelon" integer, "indice" integer, CONSTRAINT "PK_a1667e427807f9465f074cde5e9" PRIMARY KEY ("code"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "grade" ("code" character varying NOT NULL, "abreviation" character varying NOT NULL, "libelle" character varying NOT NULL, "categorie" character varying, "echelle" integer, "echelon" integer, "indice" integer, CONSTRAINT "PK_11d21d8f15e00aff70a1704326c" PRIMARY KEY ("code"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "paquet_reception" ("id" SERIAL NOT NULL, "numero" integer NOT NULL, "dateReception" date, "reference" character varying, "observation" text, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_dca8f05e3efd70921c19ae4499f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_b6453d47d4a4c5e99f9c502a57" ON "paquet_reception" ("numero") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b5864d124f0425ba2736df93b9" ON "paquet_reception" ("dateReception") `,
    );
    await queryRunner.query(
      `CREATE TABLE "lot_publication" ("id" SERIAL NOT NULL, "numero" integer NOT NULL, "paquetId" integer, "typeTexte" character varying, "quota" integer, "autres" boolean NOT NULL DEFAULT false, "rang" integer, "dateReception" date, "dateSignatureArretes" date, "dateSignatureDecrets" date, "observation" text, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_367c6b8571ba4efd6211eac67f0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_471ddaf3ab47d7c1ae5a496ae4" ON "lot_publication" ("numero") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d2c52c3087bf655531a4cdc991" ON "lot_publication" ("paquetId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "agent" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "cle" character varying NOT NULL, "feuille" character varying NOT NULL, "quota" integer, "numeroOrdre" integer, "numeroListe" integer, "nomComplet" character varying NOT NULL, "nomNormalise" character varying NOT NULL, "dateNaissance" date, "dateNaissanceBrute" character varying, "lieuNaissance" character varying, "diplomeBrut" character varying, "diplomeCode" character varying, "departementBrut" character varying, "departementId" integer, "source" character varying, "cycleBrut" character varying, "lotCommission" character varying, "statut" character varying, "transmission" character varying, "parapheur" character varying, "lieuServiceBrut" character varying, "origineBrute" character varying, "observation" text, "typeTexte" character varying, "numeroTexte" character varying, "dateSignatureTexte" date, "dateReception" date, "lotPublicationId" integer, "contractuelForce" boolean, "anomalies" jsonb NOT NULL DEFAULT '[]', "anomaliesVerifiees" jsonb NOT NULL DEFAULT '[]', "origineFiche" character varying NOT NULL DEFAULT 'IMPORT', "etatFiche" character varying, "saisiePar" character varying, "controleePar" character varying, "valideePar" character varying, "dateDepot" date, "contentieuxAge" character varying, "contentieuxPar" character varying, "repartitionId" uuid, "rectifiee" boolean NOT NULL DEFAULT false, "remarqueControle" text, "lotNature" character varying, "reporteDe" integer, "reportMotif" text, "reportePar" character varying, "reporteLe" TIMESTAMP WITH TIME ZONE, "membreCommissionId" uuid, "transmissionNumero" integer, "transmissionOrigine" integer, "misDeCoteMotif" text, "misDeCotePar" character varying, "misDeCoteLe" TIMESTAMP WITH TIME ZONE, "transmisLe" date, "textePointePar" character varying, "textePointeLe" TIMESTAMP WITH TIME ZONE, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_1000e989398c5d4ed585cf9a46f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_28397e6bbf8658e9ae310857dc" ON "agent" ("cle") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0940869371e892e7db45787472" ON "agent" ("nomNormalise") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3795883e7955ad4109c308b186" ON "agent" ("membreCommissionId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fed34e796df593e1fc5f66e5cf" ON "agent" ("transmissionNumero") `,
    );
    await queryRunner.query(
      `CREATE TABLE "affectation" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "agentId" uuid NOT NULL, "lotPublicationId" integer NOT NULL, "typeNote" character varying NOT NULL, "departementId" integer, "structure" character varying, "etablissement" character varying, "specialite" character varying, "obs" character varying, "origine" text, "statut" character varying NOT NULL DEFAULT 'A_TRAITER', "motifExclusion" text, "noteId" uuid, "traitePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "REL_a62411fcd61a4a2c367b04b78d" UNIQUE ("agentId"), CONSTRAINT "PK_dd9c6af8306b9c2d9da3eebf555" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_a62411fcd61a4a2c367b04b78d" ON "affectation" ("agentId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1a02c027208096dfcc45313dbb" ON "affectation" ("lotPublicationId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "recommandation" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "affectationId" uuid NOT NULL, "typeNote" character varying, "departementId" integer, "structure" character varying, "etablissement" character varying, "origine" text NOT NULL, "motif" text, "statut" character varying NOT NULL DEFAULT 'EN_ATTENTE', "avant" jsonb, "soumisPar" character varying, "decidePar" character varying, "dateDecision" TIMESTAMP WITH TIME ZONE, "commentaireDecision" text, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_db3282b266d5f23a1ce4126b2cf" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "note_service" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "module" character varying NOT NULL, "typeNote" character varying NOT NULL, "motif" character varying, "lotPublicationId" integer, "campagneId" integer, "anneeScolaire" character varying NOT NULL, "rang" integer NOT NULL DEFAULT '1', "numero" character varying, "dateSignature" date, "statut" character varying NOT NULL DEFAULT 'BROUILLON', "introduction" text NOT NULL, "contenu" jsonb, "commentaire" text, "creePar" character varying, "soumisePar" character varying, "valideePar" character varying, "valideeLe" TIMESTAMP WITH TIME ZONE, "conformite" jsonb NOT NULL DEFAULT '[]', "impressionPour" character varying, "impressionOrdonneePar" character varying, "impressionOrdonneeLe" TIMESTAMP WITH TIME ZONE, "scanFichier" character varying, "scanNom" character varying, "scanLe" TIMESTAMP WITH TIME ZONE, "scanPar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_70ef6a37b5e97d01b11a42feff7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "demande_mutation" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "cle" character varying NOT NULL, "numeroEnregistrement" integer NOT NULL, "dateEnregistrement" date, "nomComplet" character varying NOT NULL, "genre" character varying(1) NOT NULL DEFAULT 'M', "grade" character varying, "echelon" integer, "gradeBrut" character varying, "matricule" character varying, "typeAgent" character varying NOT NULL DEFAULT 'FONCTIONNAIRE', "statutAgent" character varying NOT NULL DEFAULT 'ENSEIGNANT', "departementOrigineId" integer, "lieuService" character varying, "cycle" character varying, "specialite" character varying, "datePriseService" date, "dureeMois" integer, "departementSolliciteId" integer, "lieuSollicite" character varying, "motif" character varying NOT NULL, "justificatif" text, "justificatifFichier" character varying, "permutationAvecId" uuid, "origine" text, "observation" text, "avisDdeppsa" character varying, "avisDdeppsaCommentaire" text, "avisDdeppsaPar" character varying, "avisDgrhas" character varying, "avisDgrhasCommentaire" text, "avisDgrhasPar" character varying, "instructionMinistre" character varying, "instructionCommentaire" text, "instructionPar" character varying, "retiree" boolean NOT NULL DEFAULT false, "motifRetrait" text, "noteId" uuid, "typePrestation" character varying, "objet" character varying, "canal" character varying NOT NULL DEFAULT 'SAISIE', "structureOrigineId" integer, "structureOrigineTexte" character varying, "telephone" character varying, "codeSuivi" character varying, "circuit" jsonb, "etapeCourante" integer, "decideur" character varying, "decision" character varying, "decisionMotivation" text, "decisionPar" character varying, "decisionLe" TIMESTAMP WITH TIME ZONE, "envoyeSecretariatLe" TIMESTAMP WITH TIME ZONE, "envoyeSecretariatPar" character varying, "anomalies" jsonb NOT NULL DEFAULT '[]', "saisiePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_8a886fa9a279a8c42c49be9bfd7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_3fd95a0b1160fd53ba22cfafe0" ON "demande_mutation" ("cle") `,
    );
    await queryRunner.query(
      `CREATE TABLE "enveloppe" ("perimetre" character varying NOT NULL, "montantAnnuel" bigint NOT NULL DEFAULT '0', "placesCatI" integer, "placesCatII" integer, "placesCatIII" integer, "modifiePar" character varying, "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_27cc55ba6e34137ab4b1db18982" PRIMARY KEY ("perimetre"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "membre_commission" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "quota" integer NOT NULL, "nom" character varying NOT NULL, "fonction" character varying, "places" integer NOT NULL DEFAULT '0', "modifiePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_653674b372824a4e016fe7020fb" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_edb55503cbcccb9d4b395100f8" ON "membre_commission" ("quota") `,
    );
    await queryRunner.query(
      `CREATE TABLE "repartition" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "quotas" jsonb NOT NULL, "personnes" integer NOT NULL, "validePar" character varying, "annulee" boolean NOT NULL DEFAULT false, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f69b28ab594148075adbd7a1528" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "beneficiaire" ("id" SERIAL NOT NULL, "nom" character varying NOT NULL, "ordre" integer NOT NULL DEFAULT '0', "actif" boolean NOT NULL DEFAULT true, "commission" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_75ead94391ccbbe2e2fa112adb7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_eb1a4d121a2a078b64cb017f8d" ON "beneficiaire" ("nom") `,
    );
    await queryRunner.query(
      `CREATE TABLE "place_beneficiaire" ("id" SERIAL NOT NULL, "perimetre" character varying NOT NULL, "beneficiaireId" integer NOT NULL, "cycle" character varying NOT NULL, "places" integer NOT NULL, CONSTRAINT "PK_8777b82be6171aadb398c5d9a19" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_728b5fc9d5df723b74b8627cbd" ON "place_beneficiaire" ("perimetre") `,
    );
    await queryRunner.query(
      `CREATE TABLE "structure" ("id" SERIAL NOT NULL, "type" character varying NOT NULL, "nom" character varying NOT NULL, "sigle" character varying NOT NULL, "parentId" integer, "departementId" integer, "actif" boolean NOT NULL DEFAULT true, "ordre" integer NOT NULL DEFAULT '0', "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_90ac7986e769d602d218075215c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d79acbd9ce11f2dad55213b6bc" ON "structure" ("type") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_62ad27d26e7b763c2d963c8acc" ON "structure" ("sigle") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_006205506f784b15e1f1524435" ON "structure" ("parentId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "type_prestation" ("code" character varying NOT NULL, "numero" integer NOT NULL, "libelle" character varying NOT NULL, "acte" character varying, "pieces" jsonb NOT NULL DEFAULT '[]', "circuitExterne" boolean NOT NULL DEFAULT true, "etapesInternes" jsonb NOT NULL DEFAULT '[]', "decision" character varying NOT NULL DEFAULT 'DGRHAS', "decisionTexte" character varying, "motifMutation" character varying, "actif" boolean NOT NULL DEFAULT false, "ordre" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_f8d40ad313c23a9dae9b684c1b5" PRIMARY KEY ("code"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "piece_demande" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "demandeId" uuid NOT NULL, "libelle" character varying NOT NULL, "nomOrigine" character varying NOT NULL, "fichier" character varying NOT NULL, "mime" character varying NOT NULL, "taille" integer NOT NULL, "ajoutePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c9295b64413e7465ca039243091" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_69aea4f2f93463b1c9adae57f4" ON "piece_demande" ("demandeId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "alerte" ("id" SERIAL NOT NULL, "demandeId" uuid NOT NULL, "type" character varying NOT NULL, "texte" text NOT NULL, "structures" jsonb NOT NULL DEFAULT '[]', "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9a7fdc9066e3a615fc265ba457c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c62e757caf539be3d10bbba24f" ON "alerte" ("demandeId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a59d6edd7257ded78244a85974" ON "alerte" ("creeLe") `,
    );
    await queryRunner.query(
      `CREATE TABLE "alerte_lue" ("alerteId" integer NOT NULL, "utilisateurId" uuid NOT NULL, "lueLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f7a5938d7d82ade79131053339b" PRIMARY KEY ("alerteId", "utilisateurId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "instruction_demande" ("id" SERIAL NOT NULL, "demandeId" uuid NOT NULL, "etape" integer NOT NULL, "texte" text NOT NULL, "echeance" date, "par" character varying, "parStructure" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_025075d03e9688ad8405ff9e197" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_329c23f3358ae250c72823cf5f" ON "instruction_demande" ("demandeId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "origine_dossier" ("id" SERIAL NOT NULL, "libelle" character varying NOT NULL, "ordre" integer NOT NULL DEFAULT '0', "actif" boolean NOT NULL DEFAULT true, "beneficiaireId" integer, CONSTRAINT "PK_d06f9e22e2a4813df31f30ebcaf" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_65a5ae454caa5e4da9d7a0f38f" ON "origine_dossier" ("libelle") `,
    );
    await queryRunner.query(
      `CREATE TABLE "ancien_recrute" ("id" SERIAL NOT NULL, "nomComplet" character varying NOT NULL, "nomNormalise" character varying NOT NULL, "dateNaissance" date, "annee" integer, "source" character varying NOT NULL, "diplome" character varying, "importePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b140fa4301ca03b4b403e122f93" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_200137589b6e0a5b1b8f0725bf" ON "ancien_recrute" ("nomNormalise") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_d720ffbbd2bbfceff000544e1a" ON "ancien_recrute" ("source") `,
    );
    await queryRunner.query(
      `CREATE TABLE "piece_jointe" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "agentId" uuid NOT NULL, "nature" character varying NOT NULL DEFAULT 'TEXTE', "legalise" boolean NOT NULL DEFAULT false, "nomOrigine" character varying NOT NULL, "fichier" character varying NOT NULL, "mime" character varying NOT NULL, "taille" integer NOT NULL, "ajoutePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_fa823c1e4f104cf1410c55c5b83" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_eebbad3e1a9e1527ebd609d234" ON "piece_jointe" ("agentId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "reference_note" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "agentId" uuid NOT NULL, "brut" character varying NOT NULL, "numero" character varying, "date" date, "lieuAffectation" character varying, "service" character varying, "lieuService" character varying, "source" character varying NOT NULL, "importePar" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c05ffdd537af6d29b5acd409bc1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cbd05bfcaa3a91c8724afea08b" ON "reference_note" ("agentId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_133687de5a56212cb9fc4f458f" ON "reference_note" ("numero") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_14c94888b547d4c821984e5c0a" ON "reference_note" ("source") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_cfc6ddca900ac166e8e14dc4d9" ON "reference_note" ("agentId", "brut") `,
    );
    await queryRunner.query(
      `CREATE TABLE "campagne_enrolement" ("id" SERIAL NOT NULL, "annee" integer NOT NULL, "anneeScolaire" character varying NOT NULL, "quota" integer NOT NULL DEFAULT '0', "enveloppe" bigint NOT NULL DEFAULT '0', "placesParCycle" jsonb NOT NULL DEFAULT '{}', "montantsParCycle" jsonb NOT NULL DEFAULT '{}', "ouverte" boolean NOT NULL DEFAULT true, "observation" character varying, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_90c2c5fa7143b70628a4a58d641" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_bfe266908716285876c9755e92" ON "campagne_enrolement" ("annee") `,
    );
    await queryRunner.query(
      `CREATE TABLE "membre_enrolement" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "campagneId" integer NOT NULL, "nom" character varying NOT NULL, "fonction" character varying, "places" integer NOT NULL DEFAULT '0', "creeLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d46fa0c9b9f3a4f7063591cb336" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8db697980efaa3d856cc399214" ON "membre_enrolement" ("campagneId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "enrole" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "campagneId" integer NOT NULL, "nomComplet" character varying NOT NULL, "nomNormalise" character varying NOT NULL, "dateNaissance" date, "lieuNaissance" character varying, "diplome" character varying NOT NULL, "diplomePrecision" character varying, "promotion" character varying, "cycle" character varying, "specialite" character varying, "departementsSouhaites" jsonb NOT NULL DEFAULT '[]', "departementRetenuId" integer, "etablissement" character varying, "telephone" character varying, "origineBrute" character varying, "membreId" uuid, "observation" text, "etat" character varying NOT NULL DEFAULT 'A_CONTROLER', "remarqueControle" text, "motifDecision" text, "saisiePar" character varying, "controlePar" character varying, "decidePar" character varying, "decideLe" TIMESTAMP WITH TIME ZONE, "noteId" uuid, "creeLe" TIMESTAMP NOT NULL DEFAULT now(), "modifieLe" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_a42e4852f20b51cfee9782d50e6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_464db437599457b1bfabaeb971" ON "enrole" ("campagneId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7c097500b7b2e5a1c9634cc3e0" ON "enrole" ("nomNormalise") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_efd4ffdf7a5d249a651c521a5c" ON "enrole" ("etat") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4428accca28328e261424fe9a7" ON "enrole" ("noteId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "agent" ADD CONSTRAINT "FK_b9c8bd3125b6a013819d9dc70e2" FOREIGN KEY ("departementId") REFERENCES "departement"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent" ADD CONSTRAINT "FK_df9d7d468d1734de713a558904f" FOREIGN KEY ("lotPublicationId") REFERENCES "lot_publication"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "affectation" ADD CONSTRAINT "FK_a62411fcd61a4a2c367b04b78d9" FOREIGN KEY ("agentId") REFERENCES "agent"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "affectation" ADD CONSTRAINT "FK_1156050fddd2976b79c68d49f77" FOREIGN KEY ("departementId") REFERENCES "departement"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" ADD CONSTRAINT "FK_f51071657dc1f5168e199aa1a49" FOREIGN KEY ("affectationId") REFERENCES "affectation"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" ADD CONSTRAINT "FK_ad1583c43e584bd7bca653fe5ba" FOREIGN KEY ("departementOrigineId") REFERENCES "departement"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" ADD CONSTRAINT "FK_6f2d3a5610d1bbefcfdb62f8fdb" FOREIGN KEY ("departementSolliciteId") REFERENCES "departement"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" DROP CONSTRAINT "FK_6f2d3a5610d1bbefcfdb62f8fdb"`,
    );
    await queryRunner.query(
      `ALTER TABLE "demande_mutation" DROP CONSTRAINT "FK_ad1583c43e584bd7bca653fe5ba"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recommandation" DROP CONSTRAINT "FK_f51071657dc1f5168e199aa1a49"`,
    );
    await queryRunner.query(
      `ALTER TABLE "affectation" DROP CONSTRAINT "FK_1156050fddd2976b79c68d49f77"`,
    );
    await queryRunner.query(
      `ALTER TABLE "affectation" DROP CONSTRAINT "FK_a62411fcd61a4a2c367b04b78d9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent" DROP CONSTRAINT "FK_df9d7d468d1734de713a558904f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "agent" DROP CONSTRAINT "FK_b9c8bd3125b6a013819d9dc70e2"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4428accca28328e261424fe9a7"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_efd4ffdf7a5d249a651c521a5c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7c097500b7b2e5a1c9634cc3e0"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_464db437599457b1bfabaeb971"`,
    );
    await queryRunner.query(`DROP TABLE "enrole"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8db697980efaa3d856cc399214"`,
    );
    await queryRunner.query(`DROP TABLE "membre_enrolement"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bfe266908716285876c9755e92"`,
    );
    await queryRunner.query(`DROP TABLE "campagne_enrolement"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cfc6ddca900ac166e8e14dc4d9"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_14c94888b547d4c821984e5c0a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_133687de5a56212cb9fc4f458f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cbd05bfcaa3a91c8724afea08b"`,
    );
    await queryRunner.query(`DROP TABLE "reference_note"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_eebbad3e1a9e1527ebd609d234"`,
    );
    await queryRunner.query(`DROP TABLE "piece_jointe"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d720ffbbd2bbfceff000544e1a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_200137589b6e0a5b1b8f0725bf"`,
    );
    await queryRunner.query(`DROP TABLE "ancien_recrute"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_65a5ae454caa5e4da9d7a0f38f"`,
    );
    await queryRunner.query(`DROP TABLE "origine_dossier"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_329c23f3358ae250c72823cf5f"`,
    );
    await queryRunner.query(`DROP TABLE "instruction_demande"`);
    await queryRunner.query(`DROP TABLE "alerte_lue"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a59d6edd7257ded78244a85974"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c62e757caf539be3d10bbba24f"`,
    );
    await queryRunner.query(`DROP TABLE "alerte"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_69aea4f2f93463b1c9adae57f4"`,
    );
    await queryRunner.query(`DROP TABLE "piece_demande"`);
    await queryRunner.query(`DROP TABLE "type_prestation"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_006205506f784b15e1f1524435"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_62ad27d26e7b763c2d963c8acc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d79acbd9ce11f2dad55213b6bc"`,
    );
    await queryRunner.query(`DROP TABLE "structure"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_728b5fc9d5df723b74b8627cbd"`,
    );
    await queryRunner.query(`DROP TABLE "place_beneficiaire"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_eb1a4d121a2a078b64cb017f8d"`,
    );
    await queryRunner.query(`DROP TABLE "beneficiaire"`);
    await queryRunner.query(`DROP TABLE "repartition"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_edb55503cbcccb9d4b395100f8"`,
    );
    await queryRunner.query(`DROP TABLE "membre_commission"`);
    await queryRunner.query(`DROP TABLE "enveloppe"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3fd95a0b1160fd53ba22cfafe0"`,
    );
    await queryRunner.query(`DROP TABLE "demande_mutation"`);
    await queryRunner.query(`DROP TABLE "note_service"`);
    await queryRunner.query(`DROP TABLE "recommandation"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1a02c027208096dfcc45313dbb"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a62411fcd61a4a2c367b04b78d"`,
    );
    await queryRunner.query(`DROP TABLE "affectation"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_fed34e796df593e1fc5f66e5cf"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3795883e7955ad4109c308b186"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0940869371e892e7db45787472"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_28397e6bbf8658e9ae310857dc"`,
    );
    await queryRunner.query(`DROP TABLE "agent"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_d2c52c3087bf655531a4cdc991"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_471ddaf3ab47d7c1ae5a496ae4"`,
    );
    await queryRunner.query(`DROP TABLE "lot_publication"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b5864d124f0425ba2736df93b9"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b6453d47d4a4c5e99f9c502a57"`,
    );
    await queryRunner.query(`DROP TABLE "paquet_reception"`);
    await queryRunner.query(`DROP TABLE "grade"`);
    await queryRunner.query(`DROP TABLE "regle_diplome"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ada6d1fc4f9bf4122ecb2966c7"`,
    );
    await queryRunner.query(`DROP TABLE "departement"`);
    await queryRunner.query(`DROP TABLE "parametre"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b8b64f4ab7601a8ba0ae2b636c"`,
    );
    await queryRunner.query(`DROP TABLE "journal"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_00b3578632111a051d146113c4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e1136325a6b28e2a02b81b2f5e"`,
    );
    await queryRunner.query(`DROP TABLE "utilisateur"`);
  }
}
