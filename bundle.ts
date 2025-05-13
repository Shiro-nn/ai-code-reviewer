import * as esbuild from "https://deno.land/x/esbuild@v0.25.4/mod.js";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@^0.11.1";


await esbuild.initialize();

await esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  format: "esm",
  plugins: [
    ...denoPlugins({
      loader: "native",
    }),
  ],
  define: {
    "DENO_ENV": "process.env",
    // replace Deno.read to fs
    "Deno.readTextFileSync": "fs.readFileSync",
  },
  banner: {
    js: 'import fs from "fs";', // чтобы fs.readFileSync работал
  },
  outfile: "dist/out.js",
});

esbuild.stop();
