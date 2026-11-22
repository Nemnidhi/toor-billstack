const buildPagination = (query = {}) => {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 100);
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

const buildSort = (sortBy, sortOrder, allowedFields, fallback = "-createdAt") => {
  if (!sortBy || !allowedFields.includes(sortBy)) {
    return fallback;
  }

  const order = String(sortOrder).toLowerCase() === "asc" ? "" : "-";
  return `${order}${sortBy}`;
};

const buildSearchFilter = (search, fields) => {
  const regex = searchRegex(search);
  if (!regex) {
    return {};
  }

  return {
    $or: fields.map((field) => ({ [field]: regex })),
  };
};

const { searchRegex } = require("./search");

const buildPaginatedResponse = ({ items, total, page, limit }) => ({
  items,
  pagination: {
    total,
    page,
    limit,
    totalPages: Math.max(Math.ceil(total / limit), 1),
  },
});

module.exports = {
  buildPaginatedResponse,
  buildPagination,
  buildSearchFilter,
  buildSort,
};

