import { cleanMrzLine } from '../src/utils/helpers.js';

const text = [
  'P<INDHALADY<<SHAILAJA<KUMARI<<<<<<<<<<<<<<<<',
  'K0037575<1IND7706105F2112080<<<<<',
  'Passport No. K0037575',
  'Date of Birth 10/06/1977',
  'Date of Expiry 08/12/2021'
].join('\n');

const lines = String(text)
  .split(/\r?\n/)
  .map((line) => cleanMrzLine(line))
  .filter((line) => line.length >= 10);

console.log('All lines after clean/filter:');
lines.forEach((l, i) => {
  console.log(`  [${i}] len=${l.length} P<=${l.startsWith('P<')} : "${l}"`);
});

const headerIndex = lines.findIndex((line) => line.startsWith('P<'));
console.log('\nheaderIndex:', headerIndex);
if (headerIndex !== -1 && lines[headerIndex + 1]) {
  const candidate = cleanMrzLine(lines[headerIndex + 1]);
  console.log('candidate after P< line:', candidate);
  console.log('  length:', candidate.length);
  console.log('  matches /^[A-Z0-9<]{42,44}$/:', /^[A-Z0-9<]{42,44}$/.test(candidate));
  console.log('  matches /^[A-Z0-9<]{28,41}$/:', /^[A-Z0-9<]{28,41}$/.test(candidate));
  console.log('  not starts with P<:', !candidate.startsWith('P<'));
}
