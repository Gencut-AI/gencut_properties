// One-off probe: find Miami-Dade's Property Point View service and print its schema and freshness.
// Prints field names, counts and dates only; no owner names.
const j = async (u) => { const r = await fetch(u); const t = await r.text(); try { return JSON.parse(t); } catch { return { _status: r.status, _text: t.slice(0, 300) }; } };
const search = [
  'https://gis-mdc.opendata.arcgis.com/api/search/v1/collections/dataset/items?q=property%20point%20view&limit=10',
  'https://gis-mdc.opendata.arcgis.com/api/search/v1/collections/all/items?q=property%20point&limit=10',
];
const urls = new Set();
for (const s of search) {
  const d = await j(s);
  for (const f of d.features ?? []) { console.log('ITEM', f.properties?.title, '|', f.properties?.type, '|', f.properties?.url, '|', f.properties?.modified); if (f.properties?.url) urls.add(f.properties.url); }
  if (!d.features) console.log('SEARCH', s, JSON.stringify(d).slice(0, 300));
}
for (const extra of ['https://gisweb.miamidade.gov/arcgis/rest/services?f=json', 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services?f=json']) {
  const d = await j(extra); console.log('DIR', extra, JSON.stringify(d).slice(0, 1500));
}
for (const base of urls) {
  const layer = /\/(FeatureServer|MapServer)\/\d+$/.test(base) ? base : `${base.replace(/\/$/, '')}/0`;
  const meta = await j(`${layer}?f=json`);
  console.log('LAYER', layer, 'maxRecordCount', meta.maxRecordCount, 'editInfo', JSON.stringify(meta.editingInfo ?? null));
  console.log('FIELDS', (meta.fields ?? []).map((f) => `${f.name}:${f.type.replace('esriFieldType', '')}`).join(', '));
  const cnt = await j(`${layer}/query?where=1%3D1&returnCountOnly=true&f=json`); console.log('COUNT', JSON.stringify(cnt));
  const dateField = (meta.fields ?? []).find((f) => /DATEOFSALE|DOS_1|SALE.*DATE/i.test(f.name))?.name;
  if (dateField) {
    const st = await j(`${layer}/query?where=1%3D1&outStatistics=${encodeURIComponent(JSON.stringify([{ statisticType: 'max', onStatisticField: dateField, outStatisticFieldName: 'mx' }]))}&f=json`);
    console.log('MAX', dateField, JSON.stringify(st.features ?? st).slice(0, 300));
  }
}
