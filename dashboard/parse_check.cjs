const parser = require('@babel/parser');
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
try {
  parser.parse(src, { sourceType: 'module', plugins: ['jsx'] });
  console.log('OK:', process.argv[2]);
} catch (e) {
  console.error('PARSE ERROR:', e.message);
  process.exit(1);
}
