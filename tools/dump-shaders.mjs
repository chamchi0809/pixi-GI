/**
 * Print the GLSL each pass compiles to. `node tools/dump-shaders.mjs [merge]`
 *
 * The shaders are written in PSL, so what actually runs on the GPU is generated
 * -- this is how you read it when you are counting fetches or ALU. Loaded
 * through Vite because the sources use TypeScript that node cannot strip.
 */
import { createServer } from 'vite';

// PixiJS probes a throwaway GL context for its float precision when a GlProgram
// is constructed. There is no GPU here and none is needed -- only the source
// text -- so give it a canvas that has no context to offer.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const root = new URL('../packages/lib/', import.meta.url).pathname.replace(/^\//, '');
const server = await createServer({
    root,
    server: { middlewareMode: true },
    logLevel: 'error',
    // Straight at the source, as the demo does -- neither workspace package is built here.
    resolve: {
        alias: { 'pixi-psl': new URL('../packages/psl/src/index.ts', import.meta.url).pathname.replace(/^\//, '') },
    },
});
const shaders = await server.ssrLoadModule('/src/shaders.ts');

const only = process.argv[2];
const build = {
    seed: shaders.seedShader,
    extend: shaders.extendShader,
    merge: shaders.mergeShader,
    resolve: shaders.resolveShader,
    composite: () => shaders.compositeShader(new Float32Array(3), new Float32Array(3)),
};

for (const [name, make] of Object.entries(build)) {
    if (only && name !== only) continue;
    const shader = make();
    const groups = Object.keys(shader.resources).join(', ');
    console.log(`\n${'='.repeat(70)}\n${name}   [resources: ${groups}]\n${'='.repeat(70)}`);
    // PSL_VERTEX=1 to see the vertex stage too -- the internal passes replace it.
    if (process.env.PSL_WGSL) {
        if (process.env.PSL_VERTEX) console.log(shader.gpuProgram.vertex.source);
        console.log(shader.gpuProgram.fragment.source);
    } else {
        if (process.env.PSL_VERTEX) console.log(shader.glProgram.vertex);
        console.log(shader.glProgram.fragment);
    }
}
await server.close();
