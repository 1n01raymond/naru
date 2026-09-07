import { readFile } from "node:fs/promises";

const DEFAULT_URL = "https://1n01raymond.github.io/naru/";
const RANGE_END = 63;

function parsePositiveInteger(value, option) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    url: DEFAULT_URL,
    packageOrigin: undefined,
    attempts: 1,
    retryDelayMs: 0,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];

    if (option === "--url" && value) {
      options.url = value;
      index += 1;
    } else if (option === "--package-origin" && value) {
      options.packageOrigin = value;
      index += 1;
    } else if (option === "--attempts" && value) {
      options.attempts = parsePositiveInteger(value, option);
      index += 1;
    } else if (option === "--retry-delay-ms" && value) {
      options.retryDelayMs = parsePositiveInteger(value, option);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${option}`);
    }
  }

  const url = new URL(options.url);
  url.pathname = `${url.pathname.replace(/\/?$/, "/")}`;
  url.search = "";
  url.hash = "";
  options.url = url.href;

  if (options.packageOrigin !== undefined) {
    const origin = new URL(options.packageOrigin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      throw new Error("--package-origin must use HTTP or HTTPS.");
    }
    if (origin.username !== "" || origin.password !== "") {
      throw new Error("--package-origin must not carry credentials.");
    }
    if (origin.search !== "" || origin.hash !== "") {
      throw new Error("--package-origin must not carry a query or fragment.");
    }
    // A package prefix names the directory holding scene.gltf, because the
    // loader resolves every declared resource against the document's own URL.
    origin.pathname = `${origin.pathname.replace(/\/?$/, "/")}`;
    options.packageOrigin = origin.href;
  }

  return options;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function loadResources(reportPath) {
  const report = JSON.parse(await readFile(new URL(reportPath, import.meta.url), "utf8"));
  assert(Array.isArray(report.output?.resources), `${reportPath} has no output resources.`);
  return report.output.resources;
}

async function fetchChecked(url, init = {}) {
  try {
    return await fetch(url, {
      ...init,
      headers: {
        "accept-encoding": "identity",
        "cache-control": "no-cache",
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // A refused redirect surfaces as a bare "fetch failed"; a smoke check that
    // does not name the URL and the reason is not worth reading in CI.
    const reason = error?.cause?.message ?? error?.message ?? String(error);
    throw new Error(`${url} could not be fetched: ${reason}`, { cause: error });
  }
}

function cacheBusted(url, attempt) {
  const result = new URL(url);
  result.searchParams.set("naru-smoke", `${Date.now()}-${attempt}`);
  return result;
}

async function checkLanding(baseUrl, attempt) {
  const landingUrl = cacheBusted(baseUrl, attempt);
  const response = await fetchChecked(landingUrl);
  assert(response.status === 200, `${landingUrl.href} returned HTTP ${response.status}.`);
  assert(
    response.headers.get("content-type")?.startsWith("text/html"),
    `${landingUrl.href} did not return HTML.`,
  );

  const html = await response.text();
  assert(html.includes("<title>NARU"), `${landingUrl.href} is not the NARU landing page.`);
  assert(html.includes('href="studio/"'), `${landingUrl.href} does not link to the Studio.`);
  assert(html.includes('href="api/"'), `${landingUrl.href} does not link to the API reference.`);

  const mediaPaths = [...html.matchAll(/(?:src|href)="(media\/[^"]+)"/gu)].map(
    (match) => match[1],
  );
  assert(mediaPaths.length > 0, `${landingUrl.href} references no evidence media.`);

  for (const mediaPath of new Set(mediaPaths)) {
    const mediaUrl = cacheBusted(new URL(mediaPath, baseUrl), attempt);
    const mediaResponse = await fetchChecked(mediaUrl, { method: "HEAD" });
    assert(mediaResponse.status === 200, `${mediaUrl.href} returned HTTP ${mediaResponse.status}.`);
  }

  return mediaPaths.length;
}

async function checkApiReference(baseUrl, attempt) {
  const indexUrl = cacheBusted(new URL("api/", baseUrl), attempt);
  const response = await fetchChecked(indexUrl);
  assert(response.status === 200, `${indexUrl.href} returned HTTP ${response.status}.`);
  assert(
    response.headers.get("content-type")?.startsWith("text/html"),
    `${indexUrl.href} did not return HTML.`,
  );

  const html = await response.text();
  assert(html.includes("<title>NARU API"), `${indexUrl.href} is not the NARU API reference.`);

  // TypeDoc's index page is the README; the package list lives on
  // `modules.html` (the index only reaches it through the navigation script).
  const modulesUrl = cacheBusted(new URL("modules.html", new URL("api/", baseUrl)), attempt);
  const modulesResponse = await fetchChecked(modulesUrl);
  assert(modulesResponse.status === 200, `${modulesUrl.href} returned HTTP ${modulesResponse.status}.`);
  const modulesHtml = await modulesResponse.text();
  const modulePaths = [...modulesHtml.matchAll(/href="(modules\/[^"]+\.html)"/gu)].map(
    (match) => match[1],
  );
  const expectedModules = ["scene-ir", "runtime-webgpu", "workspace", "compiler"];
  for (const name of expectedModules) {
    assert(
      modulePaths.some((path) => path.includes(name)),
      `${modulesUrl.href} does not list the @naru3d/${name} package.`,
    );
  }

  for (const modulePath of new Set(modulePaths)) {
    const moduleUrl = cacheBusted(new URL(modulePath, new URL("api/", baseUrl)), attempt);
    const moduleResponse = await fetchChecked(moduleUrl, { method: "HEAD" });
    assert(moduleResponse.status === 200, `${moduleUrl.href} returned HTTP ${moduleResponse.status}.`);
  }
  return modulePaths.length;
}

async function checkStudioIndex(baseUrl, attempt) {
  const indexUrl = cacheBusted(new URL("studio/", baseUrl), attempt);
  const response = await fetchChecked(indexUrl);
  assert(response.status === 200, `${indexUrl.href} returned HTTP ${response.status}.`);
  assert(
    response.headers.get("content-type")?.startsWith("text/html"),
    `${indexUrl.href} did not return HTML.`,
  );

  const html = await response.text();
  assert(html.includes("<title>NARU"), `${indexUrl.href} is not the NARU Studio page.`);

  const assetPaths = [...html.matchAll(/(?:src|href)="([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((path) => /\/assets\/[^/]+\.(?:css|js)$/u.test(path));
  assert(assetPaths.length > 0, `${indexUrl.href} declares no Vite assets.`);

  for (const assetPath of assetPaths) {
    const assetUrl = cacheBusted(new URL(assetPath, baseUrl), attempt);
    const assetResponse = await fetchChecked(assetUrl, { method: "HEAD" });
    assert(assetResponse.status === 200, `${assetUrl.href} returned HTTP ${assetResponse.status}.`);
  }

  return assetPaths;
}

// A site that was built without VITE_NARU_DEFAULT_SCENE_URL still serves a
// working Studio, so the deployed bundle is the only place that says which
// package the demo actually opens.
async function checkStudioTargetsOrigin(baseUrl, assetPaths, packageOrigin, attempt) {
  const documentHref = new URL("scene.gltf", packageOrigin).href;
  const scriptPaths = assetPaths.filter((path) => path.endsWith(".js"));
  assert(scriptPaths.length > 0, `${baseUrl} declares no Studio script asset.`);

  for (const scriptPath of scriptPaths) {
    const scriptUrl = cacheBusted(new URL(scriptPath, baseUrl), attempt);
    const response = await fetchChecked(scriptUrl);
    assert(response.status === 200, `${scriptUrl.href} returned HTTP ${response.status}.`);
    if ((await response.text()).includes(documentHref)) {
      return documentHref;
    }
  }

  throw new Error(
    `No deployed Studio script names ${documentHref}; the site was built without ` +
      "VITE_NARU_DEFAULT_SCENE_URL and would open a package that is no longer there.",
  );
}

function allowsOrigin(header, siteOrigin) {
  return header === "*" || header === siteOrigin;
}

// The loader reads Content-Range on every 206 and fails closed when it cannot,
// and that header is not CORS-safelisted: an origin that omits it renders the
// Studio shell and never delivers geometry.
function assertExposesContentRange(response, resourceUrl) {
  const exposed = (response.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase());
  assert(
    exposed.includes("*") || exposed.includes("content-range"),
    `${resourceUrl} does not expose Content-Range to the site origin.`,
  );
}

async function checkDeliveredResource(packageOrigin, siteOrigin, resource) {
  // No cache-busting query here: ADR-0023 makes a package prefix immutable, so
  // a cached response is the correct response, and an object store is entitled
  // to refuse an unexpected query parameter.
  const resourceUrl = new URL(resource.path, packageOrigin);
  const headers = { origin: siteOrigin };
  const response = await fetchChecked(resourceUrl, {
    method: "HEAD",
    headers,
    redirect: "error",
  });
  assert(response.status === 200, `${resourceUrl.href} returned HTTP ${response.status}.`);

  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  assert(
    contentLength === resource.bytes,
    `${resourceUrl.href} has ${contentLength} bytes; expected ${resource.bytes}.`,
  );
  assert(
    response.headers.get("content-type")?.startsWith(resource.mediaType),
    `${resourceUrl.href} has unexpected content type ${response.headers.get("content-type")}.`,
  );
  assert(
    allowsOrigin(response.headers.get("access-control-allow-origin"), siteOrigin),
    `${resourceUrl.href} does not allow ${siteOrigin}; it answered ` +
      `${response.headers.get("access-control-allow-origin") ?? "no Access-Control-Allow-Origin"}.`,
  );

  if (resource.mediaType !== "application/octet-stream") {
    return false;
  }

  const rangeResponse = await fetchChecked(resourceUrl, {
    headers: { ...headers, range: `bytes=0-${RANGE_END}` },
    redirect: "error",
  });
  assert(
    rangeResponse.status === 206,
    `${resourceUrl.href} Range request returned HTTP ${rangeResponse.status}.`,
  );
  assert(
    rangeResponse.headers.get("content-range") === `bytes 0-${RANGE_END}/${resource.bytes}`,
    `${resourceUrl.href} returned an unexpected Content-Range.`,
  );
  assert(
    allowsOrigin(rangeResponse.headers.get("access-control-allow-origin"), siteOrigin),
    `${resourceUrl.href} does not allow ${siteOrigin} on a Range request.`,
  );
  assertExposesContentRange(rangeResponse, resourceUrl.href);
  const range = await rangeResponse.arrayBuffer();
  assert(
    range.byteLength === RANGE_END + 1,
    `${resourceUrl.href} returned ${range.byteLength} bytes.`,
  );
  return true;
}

async function checkDeliveryOrigin(packageOrigin, siteOrigin, resources) {
  let rangeCount = 0;
  for (const resource of resources) {
    rangeCount += Number(await checkDeliveredResource(packageOrigin, siteOrigin, resource));
  }
  return rangeCount;
}

async function checkResource(baseUrl, prefix, resource, attempt) {
  const resourceUrl = cacheBusted(new URL(`${prefix}${resource.path}`, baseUrl), attempt);
  const response = await fetchChecked(resourceUrl, { method: "HEAD" });
  assert(response.status === 200, `${resourceUrl.href} returned HTTP ${response.status}.`);

  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  assert(
    contentLength === resource.bytes,
    `${resourceUrl.href} has ${contentLength} bytes; expected ${resource.bytes}.`,
  );
  assert(
    response.headers.get("content-type")?.startsWith(resource.mediaType),
    `${resourceUrl.href} has unexpected content type ${response.headers.get("content-type")}.`,
  );

  if (resource.mediaType !== "application/octet-stream") {
    return false;
  }

  const rangeResponse = await fetchChecked(resourceUrl, {
    headers: { range: `bytes=0-${RANGE_END}` },
  });
  assert(
    rangeResponse.status === 206,
    `${resourceUrl.href} Range request returned HTTP ${rangeResponse.status}.`,
  );
  assert(
    rangeResponse.headers.get("content-range") === `bytes 0-${RANGE_END}/${resource.bytes}`,
    `${resourceUrl.href} returned an unexpected Content-Range.`,
  );
  const range = await rangeResponse.arrayBuffer();
  assert(range.byteLength === RANGE_END + 1, `${resourceUrl.href} returned ${range.byteLength} bytes.`);
  return true;
}

async function checkPackage(baseUrl, prefix, resources, attempt) {
  let rangeCount = 0;
  for (const resource of resources) {
    rangeCount += Number(await checkResource(baseUrl, prefix, resource, attempt));
  }
  return rangeCount;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const digitalHubResources = await loadResources(
    "../artifacts/ifc/digital-hub/build-report.json",
  );
  const pyGamerResources = await loadResources(
    "../artifacts/phase1/adafruit-pygamer/build-report.json",
  );

  const siteOrigin = new URL(options.url).origin;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const mediaCount = await checkLanding(options.url, attempt);
      const assetPaths = await checkStudioIndex(options.url, attempt);
      const apiModuleCount = await checkApiReference(options.url, attempt);
      let delivery = "site artifact";
      let digitalHubRanges;
      if (options.packageOrigin === undefined) {
        digitalHubRanges = await checkPackage(
          options.url,
          "studio/",
          digitalHubResources,
          attempt,
        );
      } else {
        delivery = await checkStudioTargetsOrigin(
          options.url,
          assetPaths,
          options.packageOrigin,
          attempt,
        );
        digitalHubRanges = await checkDeliveryOrigin(
          options.packageOrigin,
          siteOrigin,
          digitalHubResources,
        );
      }
      const pyGamerRanges = await checkPackage(
        options.url,
        "studio/pygamer/",
        pyGamerResources,
        attempt,
      );
      console.log(
        `Public demo smoke check passed: ${mediaCount} landing media references, ` +
          `${assetPaths.length} app assets, ${apiModuleCount} API package pages, ` +
          `${digitalHubResources.length + pyGamerResources.length} package resources, ` +
          `${digitalHubRanges + pyGamerRanges} HTTP Range responses, ` +
          `default scene from ${delivery}.`,
      );
      return;
    } catch (error) {
      if (attempt === options.attempts) {
        throw error;
      }
      console.warn(`Attempt ${attempt}/${options.attempts} failed: ${error.message}`);
      await wait(options.retryDelayMs);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
