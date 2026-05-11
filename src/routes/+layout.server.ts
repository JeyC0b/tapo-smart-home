import { q } from '$lib/server/db';
import { getSetting } from '$lib/server/settings';

export async function load({ locals, cookies }: any) {
  // Theme is per-browser via cookie (not DB) so each user can have their own.
  const cookieTheme = cookies.get('theme');
  let theme: 'light' | 'dark' = cookieTheme === 'light' ? 'light' : 'dark';

  // Language: per-browser cookie wins over the installation default. We
  // whitelist values so a forged cookie can't break the dictionary lookup.
  const cookieLang = cookies.get('lang');
  let lang: 'en' | 'cs';
  if (cookieLang === 'en' || cookieLang === 'cs') {
    lang = cookieLang;
  } else {
    const def = await getSetting('default_language', 'en');
    lang = (def === 'cs') ? 'cs' : 'en';
  }

  return {
    theme,
    lang,
    isAdmin: !!locals?.isAdmin,
    passwordSet: !!locals?.adminPasswordSet
  };
}
