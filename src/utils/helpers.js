import crypto from 'node:crypto';

/**
 * Utility helper functions
 */

/**
 * Generate a cryptographically random unique ID with optional prefix
 */
export const generateId = (prefix = '') => {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${id}` : id;
};

/**
 * Format date to ISO string
 */
export const now = () => new Date().toISOString();

/**
 * Remove sensitive fields from object (like password)
 */
export const sanitize = (obj, ...fieldsToRemove) => {
  const result = { ...obj };
  fieldsToRemove.forEach(field => {
    delete result[field];
  });
  return result;
};

/**
 * Check if user has required role
 */
export const hasRole = (user, roles) => {
  if (user.role === 'SUPER_ADMIN') return true;
  return roles.includes(user.role);
};

/**
 * Paginate array
 */
export const paginate = (array, page = 1, limit = 10) => {
  const start = (page - 1) * limit;
  const end = start + limit;
  return {
    data: array.slice(start, end),
    pagination: {
      page,
      limit,
      total: array.length,
      totalPages: Math.ceil(array.length / limit)
    }
  };
};
