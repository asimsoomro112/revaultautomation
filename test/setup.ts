// Dummy env for unit tests — never real secrets.
process.env.IG_API_VERSION = process.env.IG_API_VERSION ?? "v26.0";
process.env.IG_APP_SECRET = process.env.IG_APP_SECRET ?? "test_app_secret_0123456789";
process.env.IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN ?? "test_verify_token";
process.env.GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
process.env.QSTASH_TOKEN = process.env.QSTASH_TOKEN ?? "test_qstash_token";
process.env.QSTASH_CURRENT_SIGNING_KEY = process.env.QSTASH_CURRENT_SIGNING_KEY ?? "test_qstash_current_signing_key";
process.env.QSTASH_NEXT_SIGNING_KEY = process.env.QSTASH_NEXT_SIGNING_KEY ?? "test_qstash_next_signing_key";
process.env.TZ = "Asia/Karachi";
