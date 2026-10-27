import { dateSolde, estPdf } from './pdf-pris-en-charge';

describe('PDF « Liste des agents pris en charge » (Solde)', () => {
  it('lit les dates de naissance de la Solde', () => {
    expect(dateSolde('08-OCT-89', 2026)).toBe('1989-10-08');
    expect(dateSolde('10-AUG-06', 2026)).toBe('2006-08-10');
    expect(dateSolde('22-FEB-00', 2026)).toBe('2000-02-22');
    expect(dateSolde('24-MAR-01', 2026)).toBe('2001-03-24');
    expect(dateSolde('06/09/1998', 2026)).toBe('1998-09-06');
    expect(dateSolde('05-AOÛT-97', 2026)).toBe('1997-08-05');
  });
  it('refuse une date impossible ou illisible', () => {
    expect(dateSolde('31-FEB-90', 2026)).toBeNull();
    expect(dateSolde('ABC', 2026)).toBeNull();
    expect(dateSolde('', 2026)).toBeNull();
  });
  it('reconnaît un PDF', () => {
    expect(estPdf(Buffer.from('%PDF-1.4 …'))).toBe(true);
    expect(estPdf(Buffer.from('PK\u0003\u0004'))).toBe(false);
  });
});
