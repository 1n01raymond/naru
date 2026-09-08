/**
 * Validates the committed LOD method-comparison record (issue #126).
 *
 * The record compares OCCT retessellation at declared tolerances against
 * constrained meshoptimizer simplification of the same target mesh over the
 * redistribution-approved `fixtures/step/lod-corpus.step`. The validator pins
 * the protocol, the predeclared thresholds, every arm's triangle counts and
 * pass/fail verdicts, and the per-part selection. Digests and encoded byte
 * counts are HOST-LOCAL (the OCCT adapter's output differs across hosts by a
 * few bytes) and must never be retargeted to make a re-record pass; a changed
 * count or verdict is a finding to report, not a pin to move.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const recordPath = resolve(repositoryRoot, "artifacts/lod/method-comparison/lod-method-comparison.json");

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) {
    throw new TypeError(`[lod-method] ${message}`);
  }
}

const record = JSON.parse(readFileSync(recordPath, "utf8"));
const text = readFileSync(recordPath, "utf8");

const PROTOCOL = {
  reference: { linearTolerance: 0.02, angularTolerance: 0.05 },
  retessellation: [[0.05, 0.1], [0.15, 0.15], [0.5, 0.3], [1, 0.5]],
  simplificationInput: { linearTolerance: 0.15, angularTolerance: 0.15 },
  simplification: { targetErrors: [0.5, 1], normalWeight: 0.5 },
  sampleCount: 2000,
  sampleSeed: 1,
  silhouetteResolution: 256,
  sectionSamplesPerSegment: 8,
  repeats: 2,
  identityTolerance: 0.01,
};
const SOURCE = {
  path: "fixtures/step/lod-corpus.step",
  sha256: "02c78ff73b23eb0ceab0c73cf0af43a75bdf1877db0d2425131b30766450129c",
  bytes: 114233,
  units: "mm",
};
const TOOLCHAIN = { cadquery: "2.8.0", ocp: "7.9.3.1", meshoptimizer: "1.2.0" };
const PARTS = ["curved-shell", "thin-plate-holes", "planar-control", "fillet-bracket"];
const THRESHOLD_NAMES = [
  "sampled-two-sided-p95", "sampled-two-sided-max", "analytic-max", "edge-alignment-p95", "section-p95",
  "silhouette-ratio-max", "identity-conflicts", "topology-euler-delta", "topology-boundary-delta",
];

// Pinned from the committed record (host-local digests; do not retarget).
const EXPECTED = {
  "reference": {
    "sceneSha256": "65ce844b2457b31986d7baf3c041a093cc6431dcd16881117e36c5021c1fa591",
    "sceneBytes": 18417301,
    "encodedBytes": 3358668,
    "documentSha256": "8aec2fc23bc666a1796fdaa661d4190e901eae08b1d3760fdcf41ce84c51fbec",
    "binarySha256": "1cd43bb36a13b3f7106f7d853e512e285510f27c7fa8c7f2b61e6d1e4e1d2dbb",
    "triangles": {
      "curved-shell": 30313,
      "thin-plate-holes": 5072,
      "planar-control": 28,
      "fillet-bracket": 2296
    }
  },
  "simplificationInput": {
    "sceneSha256": [
      "ca7a3bdcde2101d7a61525b78dd17a8f46a1393885470c0cf1b1cff7cc33aead",
      "ca7a3bdcde2101d7a61525b78dd17a8f46a1393885470c0cf1b1cff7cc33aead"
    ]
  },
  "arms": [
    {
      "label": "occt-0.05-0.1",
      "arm": "occt-retessellation",
      "sceneSha256": [
        "4c7333e86764f4a0d7d7af13f4212af4252816cd94f9783ed1ea20f82c718687",
        "4c7333e86764f4a0d7d7af13f4212af4252816cd94f9783ed1ea20f82c718687"
      ],
      "encodedBytes": 1051758,
      "documentSha256": "53e4f2dce7d2851c2d06e7c38cfcd63c56cc0945b1ad8e2af2b72f0cffa9c1ac",
      "binarySha256": "7e84571bcdb111e75ff8b84ff370f2bee1b157acca705b39be93f49dd49aa321",
      "parts": {
        "curved-shell": {
          "triangles": 7775,
          "pass": true,
          "failed": []
        },
        "thin-plate-holes": {
          "triangles": 2552,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 1164,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "occt-0.15-0.15",
      "arm": "occt-retessellation",
      "sceneSha256": [
        "ca7a3bdcde2101d7a61525b78dd17a8f46a1393885470c0cf1b1cff7cc33aead",
        "ca7a3bdcde2101d7a61525b78dd17a8f46a1393885470c0cf1b1cff7cc33aead"
      ],
      "encodedBytes": 577283,
      "documentSha256": "c92f5ffaf7b40f890bdd1ee8616d2f89dfce2a9dfac638a0281cbf7ad595b181",
      "binarySha256": "1c8cd9a8a2f2c0495ceed42d324111b2ed510a3373acb60e97ca632eb06e356a",
      "parts": {
        "curved-shell": {
          "triangles": 3623,
          "pass": true,
          "failed": []
        },
        "thin-plate-holes": {
          "triangles": 1712,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 784,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "occt-0.5-0.3",
      "arm": "occt-retessellation",
      "sceneSha256": [
        "9162bae88b926a901556e592d4eecccf4d1703d4ff49adda71691e17a3e1cb14",
        "9162bae88b926a901556e592d4eecccf4d1703d4ff49adda71691e17a3e1cb14"
      ],
      "encodedBytes": 235931,
      "documentSha256": "23e1b58ef14e059be8c7d10dbecb8de8b1627782fb25483a499282aed5b28c8c",
      "binarySha256": "863d81ece39c1aff34f897e5c5de218979e96cfbdf80a6a76d599cab1afd2cb5",
      "parts": {
        "curved-shell": {
          "triangles": 971,
          "pass": false,
          "failed": [
            "silhouette-ratio-max"
          ]
        },
        "thin-plate-holes": {
          "triangles": 872,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 408,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "occt-1-0.5",
      "arm": "occt-retessellation",
      "sceneSha256": [
        "7fd31cd9145dea3bcbab0edaed396d77770117c611c028c88f3662a0a22cf9ed",
        "7fd31cd9145dea3bcbab0edaed396d77770117c611c028c88f3662a0a22cf9ed"
      ],
      "encodedBytes": 144898,
      "documentSha256": "4ddbc15ab33d1e61a5dd380dd3a82c829851fdef168b2c00272e406c86098cc1",
      "binarySha256": "5d6d2077e9ef8d699741e61fc71392aa7485f3a082454f2beb389e1bb513a9ba",
      "parts": {
        "curved-shell": {
          "triangles": 405,
          "pass": false,
          "failed": [
            "silhouette-ratio-max"
          ]
        },
        "thin-plate-holes": {
          "triangles": 552,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 264,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "meshopt-per-face-locked-0.5",
      "arm": "meshoptimizer-simplification",
      "encodedBytes": 315289,
      "documentSha256": "e8d39d206960c241e880ff257170a53ffd2bee5a9e32e3c59c45d033a347ec94",
      "binarySha256": "4a3dcc73c10ecc0eee90045907a829c17b4138b023c8fdbc220806eb0965b6e8",
      "parts": {
        "curved-shell": {
          "triangles": 646,
          "pass": false,
          "failed": [
            "sampled-two-sided-p95",
            "analytic-max",
            "section-p95",
            "silhouette-ratio-max",
            "topology-boundary-delta"
          ]
        },
        "thin-plate-holes": {
          "triangles": 1712,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 784,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "meshopt-per-face-locked-1",
      "arm": "meshoptimizer-simplification",
      "encodedBytes": 301208,
      "documentSha256": "9cfdd9062a48a575b331e42fb13658d06b388baf63e198dc3959d3843ffecaf6",
      "binarySha256": "98606b3e682d666f2470255a58528328e00e71848ba3b468955566c796391ae6",
      "parts": {
        "curved-shell": {
          "triangles": 486,
          "pass": false,
          "failed": [
            "sampled-two-sided-p95",
            "analytic-max",
            "section-p95",
            "silhouette-ratio-max",
            "topology-boundary-delta"
          ]
        },
        "thin-plate-holes": {
          "triangles": 1712,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 784,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "meshopt-whole-shape-locked-0.5",
      "arm": "meshoptimizer-simplification",
      "encodedBytes": 316345,
      "documentSha256": "19cb39a2e911044f3b5c5cf72abc24bc11d331b516b684a3b05e4501ab9d8aa4",
      "binarySha256": "3f382f23218f298ad0eab088f3d0b030f9ab702e88ae7eaccf3eb5bafde7e04b",
      "parts": {
        "curved-shell": {
          "triangles": 658,
          "pass": false,
          "failed": [
            "sampled-two-sided-p95",
            "analytic-max",
            "section-p95",
            "silhouette-ratio-max",
            "topology-boundary-delta"
          ]
        },
        "thin-plate-holes": {
          "triangles": 1712,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 784,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "meshopt-whole-shape-locked-1",
      "arm": "meshoptimizer-simplification",
      "encodedBytes": 303496,
      "documentSha256": "07828d4322ac94594d9dfa22ac01a020cde58022bb2d5c7c0483f14abab94f1b",
      "binarySha256": "1b77596fd79046d96051d7ed64f1965622f0e3d746b7bd6d4cc0c741a1b11968",
      "parts": {
        "curved-shell": {
          "triangles": 512,
          "pass": false,
          "failed": [
            "sampled-two-sided-p95",
            "analytic-max",
            "section-p95",
            "silhouette-ratio-max",
            "topology-boundary-delta"
          ]
        },
        "thin-plate-holes": {
          "triangles": 1712,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 784,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "meshopt-whole-shape-unlocked-0.5",
      "arm": "meshoptimizer-simplification",
      "encodedBytes": 153169,
      "documentSha256": "61c6c2bf789ee3d71a4dd77aa4e63ae40ef52ae47615a04d687d44a71fae4813",
      "binarySha256": "d84be739f5082bbe399703bc1cd36e64b48d72f6d1b570fcb072011027608fa9",
      "parts": {
        "curved-shell": {
          "triangles": 552,
          "pass": false,
          "failed": [
            "sampled-two-sided-p95",
            "analytic-max",
            "section-p95",
            "silhouette-ratio-max",
            "topology-boundary-delta"
          ]
        },
        "thin-plate-holes": {
          "triangles": 514,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 234,
          "pass": true,
          "failed": []
        }
      }
    },
    {
      "label": "meshopt-whole-shape-unlocked-1",
      "arm": "meshoptimizer-simplification",
      "encodedBytes": 110918,
      "documentSha256": "dc1b1104bf3069b52130f8703a562ba4f7b0ef12386f3bcdec5a7f352dc4fbbb",
      "binarySha256": "5795a5984e0915be89b0f450118e452b8d41d321a097b3fc4b69004be68af46b",
      "parts": {
        "curved-shell": {
          "triangles": 348,
          "pass": false,
          "failed": [
            "sampled-two-sided-p95",
            "analytic-max",
            "edge-alignment-p95",
            "section-p95",
            "silhouette-ratio-max",
            "topology-boundary-delta"
          ]
        },
        "thin-plate-holes": {
          "triangles": 310,
          "pass": true,
          "failed": []
        },
        "planar-control": {
          "triangles": 28,
          "pass": true,
          "failed": []
        },
        "fillet-bracket": {
          "triangles": 162,
          "pass": true,
          "failed": []
        }
      }
    }
  ],
  "selected": {
    "curved-shell": {
      "label": "occt-0.15-0.15",
      "tie": false
    },
    "thin-plate-holes": {
      "label": "meshopt-whole-shape-unlocked-1",
      "tie": false
    },
    "planar-control": {
      "label": "meshopt-per-face-locked-0.5",
      "tie": true
    },
    "fillet-bracket": {
      "label": "meshopt-whole-shape-unlocked-1",
      "tie": false
    }
  }
};

const windowsPath = new RegExp("[A-Za-z]:[" + String.fromCharCode(92) + "/]", "u");
assert(record.schemaVersion === "naru.lod-method-comparison.1", "unexpected schemaVersion");
assert(record.mode === "offline-tolerance-and-simplification-comparison", "unexpected mode");
assert(record.host?.platform === "win32", "record was made on win32");
assert(!windowsPath.test(text) && !text.includes("/Users/"), "record must not carry machine-local paths");
assert(Number.isFinite(record.elapsedSeconds) && record.elapsedSeconds < 600, "elapsed time out of range");

for (const [key, value] of Object.entries(SOURCE)) {
  assert(record.source?.[key] === value, `source.${key} moved`);
}
assert(record.toolchain?.occt?.cadquery === TOOLCHAIN.cadquery, "cadquery version moved");
assert(record.toolchain?.occt?.ocp === TOOLCHAIN.ocp, "OCP version moved");
assert(record.toolchain?.meshoptimizer === TOOLCHAIN.meshoptimizer, "meshoptimizer version moved");
assert(JSON.stringify(record.protocol) === JSON.stringify(PROTOCOL), "protocol moved");
assert(typeof record.thresholdRule === "string" && record.thresholdRule.includes("Predeclared"), "threshold rule missing");
assert(typeof record.identityRule === "string" && record.identityRule.includes("identity conflict"), "identity rule missing");

const reference = record.reference;
assert(reference.deterministic === true && reference.encoding?.deterministic === true, "reference not deterministic");
assert(reference.sceneSha256.every((digest) => digest === EXPECTED.reference.sceneSha256), "reference scene digest moved");
assert(reference.sceneBytes === EXPECTED.reference.sceneBytes, "reference scene bytes moved");
assert(reference.encoding.encodedBytes === EXPECTED.reference.encodedBytes, "reference encoded bytes moved");
assert(reference.encoding.documentSha256 === EXPECTED.reference.documentSha256, "reference document digest moved");
assert(reference.encoding.binarySha256 === EXPECTED.reference.binarySha256, "reference binary digest moved");
assert(record.simplificationInput?.deterministic === true, "simplification input not deterministic");
assert(JSON.stringify(record.simplificationInput.sceneSha256) === JSON.stringify(EXPECTED.simplificationInput.sceneSha256), "simplification input digest moved");
for (const part of PARTS) {
  assert(reference.parts[part]?.triangles === EXPECTED.reference.triangles[part], `reference ${part} triangles moved`);
  assert(reference.parts[part].identity?.orphan === 0, `reference ${part} has orphan triangles`);
}

assert(Array.isArray(record.arms) && record.arms.length === EXPECTED.arms.length, "arm count moved");
for (const [index, expected] of EXPECTED.arms.entries()) {
  const arm = record.arms[index];
  const tag = `arm ${expected.label}`;
  assert(arm?.label === expected.label && arm.arm === expected.arm, `${tag} label or kind moved`);
  assert(arm.deterministic === true && arm.encoding?.deterministic === true, `${tag} not deterministic`);
  assert(JSON.stringify(arm.sceneSha256) === JSON.stringify(expected.sceneSha256), `${tag} scene digest moved`);
  assert(arm.encoding.encodedBytes === expected.encodedBytes, `${tag} encoded bytes moved`);
  assert(arm.encoding.documentSha256 === expected.documentSha256, `${tag} document digest moved`);
  assert(arm.encoding.binarySha256 === expected.binarySha256, `${tag} binary digest moved`);
  const t = expected.arm === "occt-retessellation" ? arm.options.linearTolerance : arm.options.targetError;
  const limits = new Map(arm.thresholds.map((entry) => [entry.name, entry.limit]));
  for (const name of THRESHOLD_NAMES) {
    assert(limits.has(name), `${tag} lacks the predeclared threshold ${name}`);
  }
  assert(limits.get("sampled-two-sided-p95") === t && limits.get("sampled-two-sided-max") === 2 * t, `${tag} thresholds are not the predeclared rule`);
  assert(limits.get("silhouette-ratio-max") === 0.005 && limits.get("identity-conflicts") === 0, `${tag} thresholds are not the predeclared rule`);
  for (const part of PARTS) {
    const measured = arm.parts[part];
    const pin = expected.parts[part];
    assert(measured?.triangles === pin.triangles, `${tag} ${part} triangles moved (${measured?.triangles} vs ${pin.triangles})`);
    assert(measured.triangles <= reference.parts[part].triangles, `${tag} ${part} exceeds the reference triangle count`);
    const failed = measured.checks.filter((check) => !check.pass).map((check) => check.name);
    assert(measured.pass === measured.checks.every((check) => check.pass), `${tag} ${part} verdict disagrees with its checks`);
    assert(measured.pass === pin.pass, `${tag} ${part} verdict moved`);
    assert(JSON.stringify(failed) === JSON.stringify(pin.failed), `${tag} ${part} failing checks moved: ${failed.join(",")}`);
    for (const check of measured.checks) {
      assert(check.limit === limits.get(check.name), `${tag} ${part} check ${check.name} uses a limit that was not predeclared`);
      assert(check.pass === (check.value <= check.limit), `${tag} ${part} check ${check.name} pass flag disagrees with its value`);
    }
    assert(measured.measured?.["identity-conflicts"] === 0, `${tag} ${part} has identity conflicts`);
  }
}

// Selection: fewest triangles among the passing arms, full-detail fallback otherwise.
for (const part of PARTS) {
  const selected = record.selected[part];
  const passing = record.arms.filter((arm) => arm.parts[part].pass);
  const fewest = Math.min(...passing.map((arm) => arm.parts[part].triangles));
  assert(selected?.label === EXPECTED.selected[part].label, `selection for ${part} moved`);
  assert(selected.tie === EXPECTED.selected[part].tie, `selection tie flag for ${part} moved`);
  assert(passing.some((arm) => arm.label === selected.label), `selection for ${part} names an arm that did not pass`);
  assert(selected.triangles === fewest, `selection for ${part} is not the fewest-triangle passing arm`);
  assert(selected.passingArms.length === passing.length, `selection for ${part} miscounts the passing arms`);
}

// The finding the record exists to carry: the curved shell fails every
// meshoptimizer arm and both coarse OCCT arms, so retessellation is the only
// lever for curved parts; the planar control cannot be reduced by any arm.
const curvedFailures = record.arms.filter((arm) => !arm.parts["curved-shell"].pass).map((arm) => arm.label);
assert(curvedFailures.length === 8 && record.arms.filter((arm) => arm.arm === "meshoptimizer-simplification").every((arm) => !arm.parts["curved-shell"].pass), "curved-shell failure set moved");
assert(record.arms.every((arm) => arm.parts["planar-control"].triangles === reference.parts["planar-control"].triangles), "planar control was reduced");
const unlocked = record.arms.find((arm) => arm.label === "meshopt-whole-shape-unlocked-1");
assert(unlocked?.parts["thin-plate-holes"].pass && unlocked.parts["fillet-bracket"].pass, "the unconstrained planar-dominant result moved");

const passingCells = record.arms.reduce((sum, arm) => sum + PARTS.filter((part) => arm.parts[part].pass).length, 0);
console.log(
  `[lod-method] verified ${record.arms.length} arms x ${PARTS.length} parts over ${SOURCE.path}: ${passingCells}/${record.arms.length * PARTS.length} cells pass; ` +
    `selected ${PARTS.map((part) => `${part}=${record.selected[part].label}`).join(", ")}`,
);
