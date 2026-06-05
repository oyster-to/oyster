declare const __APP_VERSION__: string;
declare const __APP_ENV__: string;

interface ImportMetaEnv {
  readonly VITE_OYSTER_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
