import * as esbuild from "npm:esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader";

await esbuild.build({
    plugins: [...denoPlugins()],
    entryPoints: ["https://deno.land/std@0.185.0/bytes/mod.ts"],
    outfile: "./dist/action.esm.js",
    bundle: true,
    format: "esm",
});

await esbuild.stop();