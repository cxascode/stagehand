// Paginate Genesys entity listings (pageNumber / pageCount).

const DEFAULT_PAGE_SIZE = 100;

async function fetchAllPages(fetch, path, query = {}) {
  const pageSize = query.pageSize || DEFAULT_PAGE_SIZE;
  let pageNumber = 1;
  let pageCount = 1;
  let allEntities = [];

  while (pageNumber <= pageCount) {
    const params = new URLSearchParams({ pageSize, pageNumber });
    for (const [key, value] of Object.entries(query)) {
      if (key === "pageSize" || value == null || value === "") continue;
      params.set(key, String(value));
    }

    const page = await fetch(`${path}?${params}`);
    const entities = page.entities || [];
    allEntities = allEntities.concat(entities);
    pageCount = page.pageCount || 1;
    pageNumber += 1;
  }

  return allEntities;
}
