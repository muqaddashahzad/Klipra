// Configuration for API endpoints
// If VITE_API_URL is set (e.g. in production), use it.
// Otherwise, default to empty string which means relative paths (proxied in dev).

export const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export const getApiUrl = (path) => {
    // Tolerate null / undefined / empty input. Without this, any past
    // project that has a clip with a missing video_url crashes ResultCard
    // during render — which blanks the entire dashboard tab.
    if (!path || typeof path !== 'string') return API_BASE_URL || '';
    if (path.startsWith('http') || path.startsWith('blob:')) return path;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${API_BASE_URL}${normalizedPath}`;
};
