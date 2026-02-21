import { readFileSync } from 'fs';
const envContent = readFileSync('.env', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...vals] = line.split('=');
  if (key && vals.length) env[key.trim()] = vals.join('=').trim();
});

const keys = ['IROS_USER_ID','IROS_USER_PASSWORD','EMONEY_NO1','EMONEY_NO2','EMONEY_PWD'];
keys.forEach(k => {
  const v = env[k] || '';
  const hasR = v.includes('\r');
  const hasSpace = v !== v.trim();
  console.log(`${k}: 길이=${v.length} / CR포함=${hasR} / 앞뒤공백=${hasSpace} / 값 존재=${v.length > 0 ? 'O' : 'X (비어있음!)'}`);
});
