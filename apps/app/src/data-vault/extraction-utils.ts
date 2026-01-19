/**
 * Extraction utilities for JSON path operations
 * Provides clean, optimal path-based data extraction
 */

/**
 * Get value at JSON path using dot notation
 * @param obj - Source object
 * @param path - Dot-notation path (e.g., "data.users" or "" for root)
 * @returns Value at path or undefined
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (path === '' || path === '.') return obj;

  const keys = path.split('.');
  let current: any = obj;

  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }

  return current;
}

/**
 * Set value at JSON path, creating intermediate objects as needed
 * @param obj - Target object
 * @param path - Dot-notation path
 * @param value - Value to set
 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (path === '' || path === '.') {
    throw new Error('Cannot set root path');
  }

  const keys = path.split('.');
  const lastKey = keys.pop()!;
  let current: any = obj;

  for (const key of keys) {
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }

  current[lastKey] = value;
}

/**
 * Delete value at JSON path
 * @param obj - Target object
 * @param path - Dot-notation path
 */
export function deleteByPath(obj: Record<string, unknown>, path: string): void {
  if (path === '' || path === '.') {
    throw new Error('Cannot delete root path');
  }

  const keys = path.split('.');
  const lastKey = keys.pop()!;
  let current: any = obj;

  for (const key of keys) {
    if (!(key in current)) return;
    current = current[key];
  }

  delete current[lastKey];
}

/**
 * Extract data at paths, returning the extracted data and modified response
 * @param response - Original MCP response
 * @param extractionPaths - Paths to extract
 * @param preservePaths - Paths to keep inline
 * @returns Tuple of [extracted data map, modified response]
 */
export function extractDataByPaths(
  response: unknown,
  extractionPaths: string[],
  preservePaths: string[] = [],
): [Map<string, unknown>, unknown] {
  const extracted = new Map<string, unknown>();

  // If no extraction paths, return original response
  if (extractionPaths.length === 0) {
    return [extracted, response];
  }

  // Clone response to avoid mutations
  const modified = JSON.parse(JSON.stringify(response));

  // Extract data at each path
  for (const path of extractionPaths) {
    const data = getByPath(response, path);
    if (data !== undefined) {
      extracted.set(path, data);
      // Remove from modified response
      if (path === '' || path === '.') {
        // Special case: extracting root level
        // We'll replace with preserved paths only
        return [extracted, buildPreservedObject(response, preservePaths)];
      } else {
        deleteByPath(modified as Record<string, unknown>, path);
      }
    }
  }

  // If preserve paths specified, build new object with only those paths
  if (preservePaths.length > 0) {
    return [extracted, buildPreservedObject(response, preservePaths)];
  }

  return [extracted, modified];
}

/**
 * Build object containing only specified paths from source
 * @param source - Source object
 * @param paths - Paths to preserve
 * @returns New object with only preserved paths
 */
function buildPreservedObject(
  source: unknown,
  paths: string[],
): Record<string, unknown> {
  if (paths.length === 0) return {};

  const result: Record<string, unknown> = {};

  for (const path of paths) {
    const value = getByPath(source, path);
    if (value !== undefined) {
      setByPath(result, path, value);
    }
  }

  return result;
}
