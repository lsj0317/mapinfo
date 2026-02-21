// SmplSrchList 전체 응답 덤프 (비용 없음, RealtyRegistry 미호출)
import crypto from 'crypto';
import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, ...vals] = line.split('=');
  if (key && vals.length) env[key.trim()] = vals.join('=').trim();
});

const { TILKO_API_KEY } = env;
const apiHost = "https://api.tilko.net";

async function getPublicKey() {
  const res = await fetch(`${apiHost}/api/Auth/GetPublicKey?APIkey=${TILKO_API_KEY}`);
  const json = await res.json();
  return json.PublicKey;
}

function rsaEncrypt(publicKeyBase64, aesKey) {
  const pem = "-----BEGIN PUBLIC KEY-----\n" + publicKeyBase64 + "\n-----END PUBLIC KEY-----";
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, aesKey).toString("base64");
}

(async () => {
  console.log("=== SmplSrchList 전체 필드 덤프 (비용 없음) ===\n");

  const pubKey = await getPublicKey();
  const aesKey = crypto.randomBytes(16);
  const encKey = rsaEncrypt(pubKey, aesKey);

  // 오산시 주소로 검색
  const testAddresses = [
    "경기도 오산시 오산동 906",
    "경기도 오산시 원동",
  ];

  for (const addr of testAddresses) {
    console.log(`\n주소: ${addr}`);
    const res = await fetch(`${apiHost}/api/v2.0/Iros2/RetrieveSmplSrchList`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "API-KEY": TILKO_API_KEY,
        "ENC-KEY": encKey,
      },
      body: JSON.stringify({ Address: addr }),
    });

    const json = await res.json();
    console.log(`Status: ${res.status} | Message: ${json.Message}`);

    const dataList = json.DataList || json.Result?.DataList || [];
    console.log(`결과 ${dataList.length}건`);

    // 첫 2개만 전체 필드 출력 (모든 key)
    dataList.slice(0, 2).forEach((item, i) => {
      console.log(`\n  [${i}] 전체 필드:`);
      Object.entries(item).forEach(([k, v]) => {
        console.log(`       ${k}: ${JSON.stringify(v)}`);
      });
    });
  }

  console.log("\n=== 분석 완료 (비용 미발생) ===");
})();
