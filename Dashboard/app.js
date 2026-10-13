const DATA_ROOT = "../Python/data/dashboard_2017";
const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const rampNumberFormat = new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 2 });
const colorByDirection = { imports: "#c45f48", exports: "#167d70" };
const waterStressColors = {
  "Low (<10%)": "#dedfdf",
  "Low - Medium (10-20%)": "#cfd3d5",
  "Medium - High (20-40%)": "#b9bfc3",
  "High (40-80%)": "#b68a90",
  "Extremely High (>80%)": "#9b6268",
};
const noWaterStressDataColor = "#d6d6d3";
const countryNames = {
  AT: "Austria", BE: "Belgium", BG: "Bulgaria", CY: "Cyprus", CZ: "Czechia",
  DE: "Germany", DK: "Denmark", EE: "Estonia", EL: "Greece", ES: "Spain",
  FI: "Finland", FR: "France", HR: "Croatia", HU: "Hungary", IE: "Ireland",
  IT: "Italy", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia", MT: "Malta",
  NL: "Netherlands", NO: "Norway", PL: "Poland", PT: "Portugal", RO: "Romania",
  SE: "Sweden", SI: "Slovenia", SK: "Slovakia", UK: "United Kingdom",
  AU: "Australia", BR: "Brazil", CA: "Canada", CH: "Switzerland", CN: "China",
  ID: "Indonesia", IN: "India", JP: "Japan", KR: "South Korea", MX: "Mexico",
  ROW: "Rest of World", RU: "Russia", TR: "Türkiye", US: "United States",
  ZA: "South Africa",
};

const dom = {
  loadStatus: document.querySelector("#load-status"),
  mapMessage: document.querySelector("#map-message"),
  regionSelect: document.querySelector("#region-select"),
  componentSelect: document.querySelector("#component-select"),
  sectorSelect: document.querySelector("#sector-select"),
  threshold: document.querySelector("#threshold-select"),
  thresholdValue: document.querySelector("#threshold-value"),
  shadeMode: document.querySelector("#shade-mode"),
  shadeLegendSwatch: document.querySelector("#shade-legend-swatch"),
  shadeLegendLabel: document.querySelector("#shade-legend-label"),
  shadeLegendTicks: document.querySelector("#shade-legend-ticks"),
  shadeNoData: document.querySelector("#shade-no-data"),
  regionCaption: document.querySelector("#region-caption"),
  summaryTitle: document.querySelector("#summary-title"),
  summarySubtitle: document.querySelector("#summary-subtitle"),
  importTotal: document.querySelector("#import-total"),
  exportTotal: document.querySelector("#export-total"),
  outsideMapNote: document.querySelector("#outside-map-note"),
  includeNonEu: document.querySelector("#include-non-eu"),
  partnerTitle: document.querySelector("#partner-title"),
  partnerCount: document.querySelector("#partner-count"),
  partnerList: document.querySelector("#partner-list"),
  mapHeading: document.querySelector("#map-heading"),
};

let manifest;
let map;
let featureLayer;
let boundaryLayer;
let flowLayer;
let hoveredRegion = null;
let pinnedRegion = null;
let direction = "imports";
let sourceCodes = [];
let demandCodes = [];
let sourceIndex = new Map();
let demandIndex = new Map();
let geometryIndex = new Map();
let regionFeatures = new Map();
let flowSource = new Uint16Array();
let flowSector = new Uint8Array();
let flowDemand = new Uint16Array();
let flowComponent = new Uint8Array();
let flowValue = new Float64Array();
let loadedRows = 0;
let summarySnapshot = null;

function formatMm3(value) {
  return `${numberFormat.format(value)} Mm³`;
}

function setLoadStatus(text, isError = false) {
  dom.loadStatus.textContent = text;
  dom.loadStatus.classList.toggle("is-error", isError);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.json();
}

function initMap(geojson, boundaries) {
  const mapCrs = new L.Proj.CRS(
    "EPSG:3035",
    "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m +no_defs +type=crs",
    {
      origin: [0, 0],
      resolutions: [65536, 32768, 16384, 8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1],
    },
  );
  map = L.map("map", {
    crs: mapCrs,
    zoomControl: false,
    scrollWheelZoom: true,
    preferCanvas: true,
    zoomSnap: 0,
    minZoom: 0,
    maxZoom: 16,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  featureLayer = L.geoJSON(geojson, {
    style: featureStyle,
    onEachFeature(feature, layer) {
      const code = feature.properties.region;
      regionFeatures.set(code, feature.properties);
      geometryIndex.set(code, geometryIndex.size);
      layer.on({
        mouseover: () => {
          hoveredRegion = code;
          refreshDashboard();
        },
        mouseout: () => {
          hoveredRegion = null;
          refreshDashboard();
        },
        click: () => {
          pinnedRegion = pinnedRegion === code ? null : code;
          dom.regionSelect.value = pinnedRegion || "";
          refreshDashboard({ fitToFlowExtent: Boolean(pinnedRegion) });
        },
      });
    },
  }).addTo(map);
  boundaryLayer = L.geoJSON(boundaries, {
    interactive: false,
    style: { color: "#526b62", weight: 1.35, opacity: 0.95 },
  }).addTo(map);
  flowLayer = L.layerGroup().addTo(map);
  const mainlandBounds = L.latLngBounds([[34, -12], [72, 35]]);
  map.fitBounds(mainlandBounds, { padding: [20, 20] });
  populateRegionSelect();
}

function featureStyle(feature) {
  const code = feature.properties.region;
  const active = activeRegion() === code;
  return {
    color: active ? colorByDirection[direction] : "#ffffff",
    weight: active ? 2.2 : 0.7,
    opacity: active ? 1 : 0.9,
    fillColor: regionFill(feature),
    fillOpacity: active ? 0.96 : 0.82,
  };
}

function regionFill(feature) {
  if (dom.shadeMode.value === "water-stress") {
    return waterStressColors[feature.properties.bws_label] || noWaterStressDataColor;
  }
  if (!regionTotals) return "#f7fbff";
  const regionIndex = demandIndex.get(feature.properties.region);
  const value = regionIndex === undefined ? 0 : regionTotals[regionIndex] || 0;
  if (value <= 0) return "#ffffff";
  const ratio = Math.log1p(value) / Math.log1p(maxRegionTotal || 1);
  if (ratio < 0.2) return "#f5faff";
  if (ratio < 0.4) return "#e2f1fa";
  if (ratio < 0.6) return "#cee7f5";
  if (ratio < 0.8) return "#b8daf0";
  return "#99c8e7";
}

let regionTotals;
let maxRegionTotal = 0;

function activeRegion() {
  return hoveredRegion || pinnedRegion;
}

function populateRegionSelect() {
  const options = [...regionFeatures.entries()].sort((left, right) => {
    const leftCountry = countryNames[left[1].country] || left[1].country;
    const rightCountry = countryNames[right[1].country] || right[1].country;
    return leftCountry.localeCompare(rightCountry) || left[0].localeCompare(right[0]);
  });
  dom.regionSelect.replaceChildren(new Option("Choose a region…", ""));
  let currentCountry = null;
  let currentGroup = null;
  for (const [code, feature] of options) {
    if (feature.country !== currentCountry) {
      currentCountry = feature.country;
      currentGroup = document.createElement("optgroup");
      currentGroup.label = `${countryNames[currentCountry] || currentCountry} (${currentCountry})`;
      dom.regionSelect.add(currentGroup);
    }
    currentGroup.append(new Option(`${code} · ${feature.region_name || code}`, code));
  }
  dom.regionSelect.disabled = false;
  dom.componentSelect.disabled = false;
  dom.sectorSelect.disabled = false;
  dom.threshold.disabled = false;
}

function initFilters() {
  dom.componentSelect.replaceChildren(
    new Option("Direct + indirect", "all"),
    new Option("Direct water use", "direct"),
    new Option("Indirect water use", "indirect"),
  );
  dom.sectorSelect.replaceChildren(new Option("All water-use sectors", "all"));
  for (const sector of manifest.source_sectors) {
    dom.sectorSelect.add(new Option(sectorLabel(sector), sector));
  }
  updateShadeLegend();
  for (const button of document.querySelectorAll(".direction-button")) {
    button.addEventListener("click", () => {
      direction = button.dataset.direction;
      for (const other of document.querySelectorAll(".direction-button")) {
        const active = other === button;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-pressed", String(active));
      }
      refreshDashboard();
    });
  }
  dom.regionSelect.addEventListener("change", () => {
    pinnedRegion = dom.regionSelect.value || null;
    hoveredRegion = null;
    refreshDashboard({ fitToFlowExtent: Boolean(pinnedRegion) });
  });
  dom.componentSelect.addEventListener("change", refreshDashboard);
  dom.sectorSelect.addEventListener("change", refreshDashboard);
  dom.shadeMode.addEventListener("change", () => {
    updateShadeLegend();
    refreshDashboard();
  });
  dom.includeNonEu.addEventListener("change", () => {
    if (summarySnapshot) renderSummary(summarySnapshot);
  });
  dom.threshold.addEventListener("input", () => {
    dom.thresholdValue.value = `${Number(dom.threshold.value).toFixed(1)} Mm³`;
    refreshDashboard();
  });
}

function updateShadeLegend() {
  const stressMode = dom.shadeMode.value === "water-stress";
  dom.shadeLegendSwatch.className = stressMode ? "legend-stress" : "legend-volume";
  dom.shadeLegendLabel.textContent = stressMode
    ? "Water stress · WRI baseline"
    : `${dom.shadeMode.value === "imports" ? "Total imports" : "Total exports"} · Mm³`;
  const tickValues = stressMode
    ? [0, 1, 2, 3, 4, 5]
    : [0, 0.2, 0.4, 0.6, 0.8, 1].map(
      share => Math.expm1(Math.log1p(maxRegionTotal) * share),
    );
  dom.shadeLegendTicks.replaceChildren(
    ...tickValues.map(value => {
      const tick = document.createElement("span");
      tick.textContent = stressMode ? String(value) : rampNumberFormat.format(value);
      return tick;
    }),
  );
  dom.shadeNoData.hidden = !stressMode;
}

function sectorLabel(code) {
  return {
    Airr: "Agriculture · irrigation",
    Aliv: "Agriculture · livestock",
    Belec: "Thermal electricity",
    Bmanu: "Manufacturing",
  }[code] || code;
}

function loadFlowTable() {
  if (!window.Papa) throw new Error("CSV parser did not load. Check the connection and reload.");
  sourceCodes = manifest.source_region_codes;
  demandCodes = manifest.demand_region_codes;
  sourceIndex = new Map(sourceCodes.map((code, index) => [code, index]));
  demandIndex = new Map(demandCodes.map((code, index) => [code, index]));
  const sectorIndex = new Map(manifest.source_sectors.map((code, index) => [code, index]));
  const componentIndex = new Map([["direct", 0], ["indirect", 1]]);
  flowSource = new Uint16Array(manifest.flow_rows);
  flowSector = new Uint8Array(manifest.flow_rows);
  flowDemand = new Uint16Array(manifest.flow_rows);
  flowComponent = new Uint8Array(manifest.flow_rows);
  flowValue = new Float64Array(manifest.flow_rows);

  const flowUrl = new URL(`${DATA_ROOT}/${manifest.flow_file}`, import.meta.url).href;
  window.Papa.parse(flowUrl, {
    download: true,
    worker: true,
    header: true,
    skipEmptyLines: true,
    chunkSize: 1024 * 1024,
    chunk(results) {
      for (const row of results.data) {
        const source = sourceIndex.get(row.source_region);
        const sector = sectorIndex.get(row.source_sector);
        const demand = demandIndex.get(row.demanding_region);
        const component = componentIndex.get(row.component);
        const value = Number(row.flow_mm3);
        if (source === undefined || sector === undefined || demand === undefined || component === undefined || !Number.isFinite(value)) {
          throw new Error(`Invalid flow row near record ${loadedRows + 1}`);
        }
        flowSource[loadedRows] = source;
        flowSector[loadedRows] = sector;
        flowDemand[loadedRows] = demand;
        flowComponent[loadedRows] = component;
        flowValue[loadedRows] = value;
        loadedRows += 1;
      }
      setLoadStatus(`Loading ${numberFormat.format(loadedRows)} / ${numberFormat.format(manifest.flow_rows)} flows`);
    },
    complete() {
      if (loadedRows !== manifest.flow_rows) {
        showError(`Expected ${manifest.flow_rows} flow rows but read ${loadedRows}.`);
        return;
      }
      initFilters();
      setLoadStatus(`${numberFormat.format(loadedRows)} flows ready`);
      dom.mapMessage.textContent = "Hover or select a region to reveal only its import or export connections.";
      refreshDashboard();
    },
    error(error) {
      showError(`Could not load flow data: ${error.message}`);
    },
  });
}

function filtersMatch(index) {
  const component = dom.componentSelect.value;
  if (component === "direct" && flowComponent[index] !== 0) return false;
  if (component === "indirect" && flowComponent[index] !== 1) return false;
  const sector = dom.sectorSelect.value;
  if (sector !== "all" && manifest.source_sectors[flowSector[index]] !== sector) return false;
  return true;
}

function refreshDashboard({ fitToFlowExtent = false } = {}) {
  if (!map || !loadedRows || !dom.componentSelect.options.length) return;
  const focus = activeRegion();
  const importsByRegion = new Float64Array(demandCodes.length);
  const exportsByRegion = new Float64Array(demandCodes.length);
  const importPartners = new Map();
  const exportPartners = new Map();
  let importTotal = 0;
  let exportTotal = 0;
  let outsideMapImports = 0;

  for (let index = 0; index < loadedRows; index += 1) {
    if (!filtersMatch(index)) continue;
    const sourceCode = sourceCodes[flowSource[index]];
    const demandCode = demandCodes[flowDemand[index]];
    if (sourceCode === demandCode) continue;
    const amount = flowValue[index];

    importsByRegion[flowDemand[index]] += amount;
    const mappedSourceIndex = demandIndex.get(sourceCode);
    if (mappedSourceIndex !== undefined) exportsByRegion[mappedSourceIndex] += amount;

    if (!focus) continue;
    if (demandCode === focus) {
      importTotal += amount;
      const current = importPartners.get(sourceCode) || 0;
      importPartners.set(sourceCode, current + amount);
      if (!geometryIndex.has(sourceCode)) outsideMapImports += amount;
    }
    if (sourceCode === focus) {
      exportTotal += amount;
      const current = exportPartners.get(demandCode) || 0;
      exportPartners.set(demandCode, current + amount);
    }
  }

  regionTotals = dom.shadeMode.value === "exports" ? exportsByRegion : importsByRegion;
  maxRegionTotal = Math.max(...regionTotals);
  updateShadeLegend();
  featureLayer.setStyle(featureStyle);
  drawFocusedFlows(
    focus,
    direction === "imports" ? importPartners : exportPartners,
    fitToFlowExtent,
  );
  summarySnapshot = {
    focus,
    importTotal,
    exportTotal,
    outsideMapImports,
    importPartners,
    exportPartners,
  };
  renderSummary(summarySnapshot);
  dom.mapHeading.textContent = direction === "imports" ? "Imports into selected region" : "Exports from selected region";
}

function drawFocusedFlows(focus, partners, fitToFlowExtent = false) {
  flowLayer.clearLayers();
  if (!focus) {
    dom.mapMessage.textContent = "Hover or select a region to reveal only its import or export connections.";
    return;
  }
  const focusLayer = featureLayer.getLayers().find((layer) => layer.feature.properties.region === focus);
  if (!focusLayer) return;
  const focusCenter = focusLayer.getBounds().getCenter();
  const focusBounds = focusLayer.getBounds();
  const flowBounds = L.latLngBounds(
    focusBounds.getSouthWest(),
    focusBounds.getNorthEast(),
  );
  const minFlow = Number(dom.threshold.value);
  const visible = [...partners.entries()]
    .filter(([code, amount]) => code !== "ROW" && geometryIndex.has(code) && amount >= minFlow)
    .sort((left, right) => right[1] - left[1]);
  const maxFlow = visible.length ? visible[0][1] : 1;
  const color = colorByDirection[direction];

  for (const [partnerCode, amount] of visible) {
    const partnerLayer = featureLayer.getLayers().find((layer) => layer.feature.properties.region === partnerCode);
    if (!partnerLayer) continue;
    const partnerCenter = partnerLayer.getBounds().getCenter();
    const start = direction === "imports" ? partnerCenter : focusCenter;
    const end = direction === "imports" ? focusCenter : partnerCenter;
    flowBounds.extend(start);
    flowBounds.extend(end);
    const width = 1.2 + 2.8 * (Math.log1p(amount) / Math.log1p(maxFlow));
    L.polyline([start, end], {
      color,
      weight: width,
      opacity: 0.78,
      interactive: false,
      lineCap: "round",
    }).addTo(flowLayer);
    addArrowHead(start, end, color);
  }
  if (fitToFlowExtent) {
    const paddedBounds = flowBounds.pad(0.08);
    map.fitBounds(paddedBounds, {
      padding: [32, 32],
      maxZoom: window.matchMedia("(max-width: 760px)").matches ? 6 : 7,
      animate: true,
    });
  }
  const mappedPartnerCount = [...partners.keys()].filter(
    (code) => code !== "ROW" && geometryIndex.has(code),
  ).length;
  dom.mapMessage.textContent = `${visible.length} mapped ${direction === "imports" ? "origins" : "destinations"} shown · ${mappedPartnerCount} NUTS-2 partners · arrows below ${minFlow.toFixed(1)} Mm³ hidden`;
}

function addArrowHead(start, end, color) {
  const startPoint = map.project(start, map.getZoom());
  const endPoint = map.project(end, map.getZoom());
  const angle = Math.atan2(endPoint.x - startPoint.x, -(endPoint.y - startPoint.y)) * 180 / Math.PI;
  const icon = L.divIcon({
    className: "flow-arrow-icon",
    html: `<span class="arrow-head" style="--arrow-color:${color};transform:rotate(${angle}deg)"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  L.marker(end, { icon, interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(flowLayer);
}

function renderSummary({ focus, importTotal, exportTotal, outsideMapImports, importPartners, exportPartners }) {
  const selected = focus ? regionFeatures.get(focus) : null;
  const name = selected?.region_name || focus;
  const includeNonEu = dom.includeNonEu.checked;
  const displayedImportTotal = includeNonEu ? importTotal : importTotal - outsideMapImports;
  const outsideMapImportShare = importTotal > 0 ? (outsideMapImports / importTotal) * 100 : 0;
  const outsideMapImportAmount = `${formatMm3(outsideMapImports)} (${outsideMapImportShare.toFixed(1)}% of total imports)`;
  dom.regionCaption.textContent = selected ? `${name} · ${selected.country} · ${focus}` : "No region selected";
  dom.summaryTitle.textContent = selected ? name : "Regional dependency";
  dom.summarySubtitle.textContent = selected ? `${selected.country} · ${focus} · 2017` : "Select a region to inspect its flows";
  dom.importTotal.textContent = selected ? numberFormat.format(displayedImportTotal) : "—";
  dom.exportTotal.textContent = selected ? numberFormat.format(exportTotal) : "—";
  dom.outsideMapNote.hidden = !selected || outsideMapImports <= 0;
  dom.outsideMapNote.textContent = outsideMapImports > 0
    ? includeNonEu
      ? `${outsideMapImportAmount} from non-EU sources are included. They have no NUTS-2 map arrows; exports are unaffected.`
      : `${outsideMapImportAmount} from non-EU sources are excluded. Exports are unaffected. Include them with the checkbox below.`
    : "";

  let partners = direction === "imports" ? importPartners : exportPartners;
  if (direction === "imports" && !includeNonEu) {
    partners = new Map([...partners].filter(([code]) => geometryIndex.has(code)));
  }
  dom.partnerTitle.textContent = direction === "imports" ? "Import origins" : "Export destinations";
  dom.partnerCount.textContent = selected ? `${partners.size} partners` : "—";
  dom.partnerList.replaceChildren();
  if (!selected) {
    dom.partnerList.innerHTML = '<li class="empty-state">Choose or hover over a region to see its flow partners.</li>';
    return;
  }
  const rows = [...partners.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8);
  if (!rows.length) {
    dom.partnerList.innerHTML = '<li class="empty-state">No inter-regional flows for these filters.</li>';
    return;
  }
  const maxValue = rows[0][1];
  for (const [code, amount] of rows) {
    const item = document.createElement("li");
    item.className = geometryIndex.has(code) ? "partner-item" : "partner-item is-external";
    const partnerName = regionFeatures.get(code)?.region_name || countryNames[code] || code;
    const partnerCountryCode = regionFeatures.get(code)?.country;
    const partnerCountry = partnerCountryCode
      ? countryNames[partnerCountryCode] || partnerCountryCode
      : code === "ROW" ? "Global aggregate" : "Non-EU source";
    item.innerHTML = `<div class="partner-topline"><span class="partner-name">${escapeHtml(partnerName)}</span><span class="partner-value">${numberFormat.format(amount)} Mm³</span></div><div class="partner-meta"><span>${escapeHtml(code)} · ${escapeHtml(partnerCountry)}</span><i style="--bar-width:${(amount / maxValue) * 100}%"></i></div>`;
    dom.partnerList.append(item);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function showError(message) {
  setLoadStatus("Data unavailable", true);
  dom.mapMessage.textContent = message;
  dom.partnerList.innerHTML = `<li class="empty-state error-state">${escapeHtml(message)}</li>`;
}

async function start() {
  if (!window.L) throw new Error("Leaflet did not load. Check the connection and reload.");
  if (!window.proj4 || !L.Proj?.CRS) throw new Error("Projection library did not load. Check the connection and reload.");
  const [loadedManifest, geojson, boundaries] = await Promise.all([
    fetchJson(`${DATA_ROOT}/manifest.json`),
    fetchJson(`${DATA_ROOT}/nuts2_regions.geojson`),
    fetchJson(`${DATA_ROOT}/country_boundaries.geojson`),
  ]);
  manifest = loadedManifest;
  initMap(geojson, boundaries);
  setLoadStatus("Preparing flow data…");
  loadFlowTable();
}

start().catch((error) => showError(error.message));