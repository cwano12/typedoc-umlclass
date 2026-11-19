import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Application } from "typedoc";

const plugin = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function render(options, verify) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "umlclass-test-"));
    try {
        const source = path.join(directory, "index.ts");
        const tsconfig = path.join(directory, "tsconfig.json");
        await writeFile(
            source,
            `
            export class Standalone { value: string = "example"; }
            export class Base { id: number = 1; }
            export class Child extends Base {}
            export interface Contract { value: string; }
        `,
        );
        await writeFile(
            tsconfig,
            JSON.stringify({ compilerOptions: { target: "ES2022", skipLibCheck: true }, files: [source] }),
        );
        const app = await Application.bootstrapWithPlugins({
            entryPoints: [source.replaceAll("\\", "/")],
            tsconfig,
            plugin: [plugin],
            readme: "none",
            logLevel: "Error",
            umlClassDiagram: { location: "remote", legendType: "none", ...options },
        });
        const project = await app.convert();
        assert.ok(project, "TypeDoc converts the fixture");
        assert.equal(app.logger.hasErrors(), false, "TypeDoc reports no conversion errors");
        const output = path.join(directory, "html");
        await app.generateDocs(project, output);
        await verify(
            async (name, kind = "classes") => readFile(path.join(output, kind, `${name}.html`), "utf8"),
            output,
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const diagram = /<section class="tsd-panel tsd-hierarchy-diagram">/;

test("default coverage inserts diagrams only for hierarchy members", async () => {
    await render({}, async (page) => {
        assert.match(await page("Base"), diagram);
        assert.match(await page("Child"), diagram);
        assert.doesNotMatch(await page("Standalone"), diagram);
        assert.doesNotMatch(await page("Contract", "interfaces"), diagram);
    });
});

for (const position of ["above", "below"]) {
    test(`all coverage inserts standalone class and interface diagrams (${position})`, async () => {
        await render({ coverage: "all", position }, async (page) => {
            for (const name of ["Standalone", "Base", "Child"]) assert.match(await page(name), diagram);
            assert.match(await page("Contract", "interfaces"), diagram);
            const html = await page("Child");
            const diagramIndex = html.search(diagram);
            const hierarchyIndex = html.indexOf('class="tsd-panel tsd-hierarchy"');
            assert.ok(hierarchyIndex >= 0);
            assert.equal(diagramIndex < hierarchyIndex, position === "above");
        });
    });
}

for (const coverage of ["hierarchy", "all"]) {
    test(`excluded declarations receive no diagram (${coverage})`, async () => {
        await render({ coverage, excludedClasses: ["Child", "Standalone", "Contract"] }, async (page) => {
            assert.match(await page("Base"), diagram);
            for (const name of ["Child", "Standalone"]) assert.doesNotMatch(await page(name), diagram);
            assert.doesNotMatch(await page("Contract", "interfaces"), diagram);
        });
    });
}

test("disabled plugin leaves pages without diagrams", async () => {
    await render({ type: "none", coverage: "all" }, async (page) => {
        assert.doesNotMatch(await page("Base"), diagram);
        assert.doesNotMatch(await page("Standalone"), diagram);
    });
});

for (const location of ["local", "embed"]) {
    test(`renders actual SVG diagrams with Java (${location})`, { timeout: 60000 }, async () => {
        await render(
            { coverage: "all", location, generatorProcessCount: 1, hideProgressBar: true },
            async (page, output) => {
                const html = await page("Standalone");
                assert.match(html, diagram);
                let svg;
                if (location === "local") {
                    const image = html.match(/src="(\.\.\/assets\/Standalone-umlClassDiagram-\d+\.svg)"/);
                    assert.ok(image, "the page links to a generated SVG");
                    svg = await readFile(path.resolve(output, "classes", image[1]), "utf8");
                } else {
                    const image = html.match(/src="data:image\/svg\+xml;base64,([^"]+)"/);
                    assert.ok(image, "the page embeds the generated SVG");
                    svg = Buffer.from(image[1], "base64").toString("utf8");
                }
                assert.match(svg, /<svg\b/);
                assert.match(svg, /Standalone/);
                assert.doesNotMatch(svg, /Syntax Error/);
            },
        );
    });
}
