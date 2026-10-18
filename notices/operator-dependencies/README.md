# Operator dependency notices

The operator artifact retains the exact license files for its six runtime
packages: `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/core`
2.3.1, Zod 4.4.3, prompts 2.4.2, kleur 3.0.3 and sisteransi 1.0.5.
Those files remain alongside each dependency under `node_modules/`.

The published MCP server already inlines additional libraries into its runtime
JavaScript. This directory supplies their exact upstream notices; it does not
replace the MCP license, rewrite dependency code or add another runtime copy.
Versions were identified from the retained bundle's source-region markers.

| Inlined library | Version | Package-declared license |
| --- | --- | --- |
| Ajv | 8.18.0 | MIT |
| ajv-formats | 3.0.1 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| fast-uri | 3.1.0 | BSD-3-Clause |
| content-type | 1.0.5 | MIT |

The MCP packages declare Apache-2.0 in package metadata, but their complete
LICENSE records a transition: new contributions use Apache-2.0; unrelicensed
earlier contributions retain MIT; documentation excluding specifications is
CC-BY-4.0. Preserve that complete text rather than replacing it with the metadata
label. Other package and inlined notices retain their copyright, permission,
redistribution, disclaimer and non-endorsement terms as written.

The [provenance record](provenance.json) includes exact public registry and
tarball URLs, SHA-512 integrity, archive/metadata/notice SHA-256 digests, and the
installed bundle locations. License text was extracted from those exact
tarballs without executing package scripts. This verifies retained notice bytes
and registry-declared archive integrity; it is not an independent registry
signature audit or a legal compatibility opinion. No conflicting term was
identified by this bounded notice inventory. Additional distribution review may
still be required.

Firedrill client permission is separately specified by `clients/LICENSE.md`
(packaged as `LICENSE.md`); it does not relicense any of these dependencies.
