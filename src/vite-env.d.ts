/// <reference types="vite/client" />

// .env.local dosyasındaki değişkenlerin tipleri (import.meta.env.VITE_... diye okunuyorlar).
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
}
