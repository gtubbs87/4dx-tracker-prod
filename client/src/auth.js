import { api } from './api.js';

export function oktaLoginUrl() {
  return '/auth/okta/login';
}

export function logout() {
  fetch('/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
}

export async function fetchMe() {
  return api.get('/api/users/me');
}
