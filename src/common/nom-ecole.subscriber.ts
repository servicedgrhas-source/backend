import { Injectable } from '@nestjs/common';
import {
  DataSource,
  type EntitySubscriberInterface,
  type InsertEvent,
  type UpdateEvent,
} from 'typeorm';
import { Structure } from '../entities';
import { nomStructureNorme, sansTypeEcole } from './nom-ecole';

/**
 * Chaque école enregistrée prend le nom normé (DG, 21/11/2026) : préfixe de son cycle + nom propre,
 * quelle que soit la page qui l'écrit (organigramme, répertoire, import, nominations…). Un cycle
 * changé change le préfixe. L'ancien nom reste reconnu (anciens noms).
 */
@Injectable()
export class NomEcoleSubscriber implements EntitySubscriberInterface<Structure> {
  constructor(ds: DataSource) {
    ds.subscribers.push(this);
  }

  listenTo() {
    return Structure;
  }

  beforeInsert(e: InsertEvent<Structure>) {
    const s = e.entity;
    if (!s || s.type !== 'ETABLISSEMENT' || !s.nom) return;
    const nouveau = nomStructureNorme(s);
    if (nouveau === s.nom) return;
    // Le sigle d'une école est son nom (sauf s'il dit autre chose)
    if (!s.sigle || sansTypeEcole(s.sigle) === sansTypeEcole(s.nom))
      s.sigle = nouveau.slice(0, 80);
    s.nom = nouveau;
  }

  beforeUpdate(e: UpdateEvent<Structure>) {
    const s = e.entity as Partial<Structure> | undefined;
    const avant = e.databaseEntity as Structure | undefined;
    if (!s) return;
    const type = s.type ?? avant?.type;
    if (type !== 'ETABLISSEMENT') return;
    // Rien qui touche le nom ni le cycle : on ne change rien
    if (s.nom === undefined && s.cycle === undefined) return;
    const nomActuel = s.nom ?? avant?.nom;
    if (!nomActuel) return;
    const cycle = s.cycle !== undefined ? s.cycle : avant?.cycle;
    const nouveau = nomStructureNorme({ type, cycle, nom: nomActuel });
    if (nouveau === (avant?.nom ?? s.nom)) {
      if (s.nom !== undefined) s.nom = nouveau;
      return;
    }
    s.nom = nouveau;
    const sigle = s.sigle ?? avant?.sigle;
    if (!sigle || sansTypeEcole(sigle) === sansTypeEcole(nomActuel))
      s.sigle = nouveau.slice(0, 80);
    if (avant?.nom && avant.nom !== nouveau) {
      const anciens = new Set(s.anciensNoms ?? avant.anciensNoms ?? []);
      anciens.add(avant.nom);
      s.anciensNoms = [...anciens];
    }
  }
}
