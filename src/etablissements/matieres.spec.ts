import { matiereEnseignant, reconnaitreMatiere } from './matieres';

// Matières du collège et du lycée, comme dans Référentiels › Matières
const COLLEGE = new Map([
  ['ANG_COL', 'Anglais'],
  ['ART-COL', 'Art-Plastique'],
  ['EPS_COL', 'E.P.S.'],
  ['FR_COL', 'Français'],
  ['HG_COL', 'Histoire-Géographie'],
  ['MATHS_COL', 'Mathématiques'],
  ['MUS_COL', 'Musique'],
  ['PC_COL', 'Physique-Chimie'],
  ['SVT_COL', 'S.V.T.'],
]);
const LYCEE = new Map([
  ['FR_LYC', 'Français'],
  ['LVE_LYC', 'Langue Vivante Etrangère'],
  ['PHILO_LYC', 'Philosophie'],
  ['SVT_LYC', 'S.V.T.'],
]);

describe('Matière enseignée, quelle que soit son écriture', () => {
  it('écrite comme au programme, avec ou sans accents', () => {
    expect(reconnaitreMatiere('Français', COLLEGE)).toBe('FR_COL');
    expect(reconnaitreMatiere('FRANCAIS', COLLEGE)).toBe('FR_COL');
    expect(reconnaitreMatiere('S.V.T.', COLLEGE)).toBe('SVT_COL');
    expect(reconnaitreMatiere('histoire-géographie', COLLEGE)).toBe('HG_COL');
  });
  it('abréviations et autres noms', () => {
    expect(reconnaitreMatiere('Maths', COLLEGE)).toBe('MATHS_COL');
    expect(reconnaitreMatiere('SVT', COLLEGE)).toBe('SVT_COL');
    expect(
      reconnaitreMatiere('Sciences de la vie et de la terre', COLLEGE),
    ).toBe('SVT_COL');
    expect(reconnaitreMatiere('PC', COLLEGE)).toBe('PC_COL');
    expect(reconnaitreMatiere('Sciences physiques', COLLEGE)).toBe('PC_COL');
    expect(reconnaitreMatiere('HG', COLLEGE)).toBe('HG_COL');
    expect(reconnaitreMatiere('Education physique et sportive', COLLEGE)).toBe(
      'EPS_COL',
    );
    expect(reconnaitreMatiere('Lettres modernes', COLLEGE)).toBe('FR_COL');
    expect(reconnaitreMatiere('Espagnol', LYCEE)).toBe('LVE_LYC');
    expect(reconnaitreMatiere('Philo', LYCEE)).toBe('PHILO_LYC');
  });
  it('début du nom quand une seule matière convient', () => {
    expect(reconnaitreMatiere('Anglais LV1', COLLEGE)).toBe('ANG_COL');
    expect(reconnaitreMatiere('Mathématiques-Physique', COLLEGE)).toBe(
      'MATHS_COL',
    );
  });
  it('rien quand on ne sait pas (pas de devinette)', () => {
    expect(reconnaitreMatiere('', COLLEGE)).toBeNull();
    expect(reconnaitreMatiere('Enseignant', COLLEGE)).toBeNull();
    expect(reconnaitreMatiere('Philosophie', COLLEGE)).toBeNull();
  });
  it('EPS d’après le diplôme ou la fonction, la spécialité d’abord', () => {
    expect(
      matiereEnseignant({ specialite: null, diplome: 'CAPA EPS' }, COLLEGE),
    ).toBe('EPS_COL');
    expect(
      matiereEnseignant(
        { specialite: null, fonction: "Professeur adjoint d'EPS" },
        COLLEGE,
      ),
    ).toBe('EPS_COL');
    expect(
      matiereEnseignant({ specialite: null, diplome: 'DEMEPS' }, COLLEGE),
    ).toBe('EPS_COL');
    expect(
      matiereEnseignant(
        { specialite: 'Anglais', diplome: 'CAPA EPS' },
        COLLEGE,
      ),
    ).toBe('ANG_COL');
    expect(
      matiereEnseignant(
        { specialite: null, diplome: 'CAPES', fonction: 'Enseignant' },
        COLLEGE,
      ),
    ).toBeNull();
  });
});
