// One-off probe 2: code formats and volume of recent sales. No owner names printed.
const L = 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PaGISView_gdb/FeatureServer/0';
const j = async (q) => (await fetch(`${L}/query?${new URLSearchParams({ f: 'json', ...q })}`)).json();
const rows = await j({ where: "DOS_1 >= '20261001' AND PRICE_1 >= 10000", outFields: 'FOLIO,DOR_CODE_CUR,DOR_DESC,DOS_1,PRICE_1,CONDO_FLAG,UNIT_COUNT,TRUE_SITE_ZIP_CODE,ASSESSMENT_YEAR_CUR,PARENT_FOLIO', resultRecordCount: '12' });
for (const f of rows.features ?? []) console.log('ROW', JSON.stringify(f.attributes));
const codes = await j({ where: "DOS_1 >= '20260901'", groupByFieldsForStatistics: 'DOR_CODE_CUR,DOR_DESC', outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' }]), orderByFields: 'n DESC', resultRecordCount: '40' });
for (const f of codes.features ?? []) console.log('CODE', JSON.stringify(f.attributes));
for (const [label, where] of [
  ['sales>=10k since 2026-09-01', "DOS_1 >= '20260901' AND PRICE_1 >= 10000"],
  ['sales>=10k since 2026-10-01', "DOS_1 >= '20261001' AND PRICE_1 >= 10000"],
  ['company-like owners since 2026-09-01', "DOS_1 >= '20260901' AND PRICE_1 >= 10000 AND (TRUE_OWNER1 LIKE '%LLC%' OR TRUE_OWNER1 LIKE '%INC%' OR TRUE_OWNER1 LIKE '%CORP%' OR TRUE_OWNER1 LIKE '% LP%' OR TRUE_OWNER1 LIKE '%LTD%')"],
  ['sales>=10k since 2025-01-01', "DOS_1 >= '20250101' AND PRICE_1 >= 10000"],
]) console.log('COUNT', label, JSON.stringify(await j({ where, returnCountOnly: 'true' })));
const byDay = await j({ where: "DOS_1 >= '20261015'", groupByFieldsForStatistics: 'DOS_1', outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' }]), orderByFields: 'DOS_1' });
console.log('BYDAY', JSON.stringify((byDay.features ?? []).map((f) => f.attributes)));
