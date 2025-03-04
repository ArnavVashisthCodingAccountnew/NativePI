import Constants from 'expo-constants';
import { Platform, UnavailabilityError } from 'expo-modules-core';
import invariant from 'invariant';
import qs from 'qs';
import { useEffect, useState } from 'react';
import { EmitterSubscription } from 'react-native';
import URL from 'url-parse';

import NativeLinking from './ExpoLinking';
import {
  CreateURLOptions,
  ParsedURL,
  QueryParams,
  SendIntentExtras,
  URLListener,
} from './Linking.types';
import { hasCustomScheme, resolveScheme } from './Schemes';

function validateURL(url: string): void {
  invariant(typeof url === 'string', 'Invalid URL: should be a string. Was: ' + url);
  invariant(url, 'Invalid URL: cannot be empty');
}

function getHostUri(): string | null {
  if (Constants.manifest?.hostUri) {
    return Constants.manifest.hostUri;
  } else if (Constants.manifest2?.extra?.expoClient?.hostUri) {
    return Constants.manifest2.extra.expoClient.hostUri;
  } else if (!hasCustomScheme()) {
    // we're probably not using up-to-date xdl, so just fake it for now
    // we have to remove the /--/ on the end since this will be inserted again later
    return removeScheme(Constants.linkingUri).replace(/\/--($|\/.*$)/, '');
  } else {
    return null;
  }
}

function isExpoHosted(): boolean {
  const hostUri = getHostUri();
  return !!(
    hostUri &&
    (/^(.*\.)?(expo\.io|exp\.host|exp\.direct|expo\.test)(:.*)?(\/.*)?$/.test(hostUri) ||
      Constants.manifest?.developer)
  );
}

function removeScheme(url: string): string {
  return url.replace(/^[a-zA-Z0-9+.-]+:\/\//, '');
}

function removePort(url: string): string {
  return url.replace(/(?=([a-zA-Z0-9+.-]+:\/\/)?[^/]):\d+/, '');
}

function removeLeadingSlash(url: string): string {
  return url.replace(/^\//, '');
}

function removeTrailingSlashAndQueryString(url: string): string {
  return url.replace(/\/?\?.*$/, '');
}

function ensureTrailingSlash(input: string, shouldAppend: boolean): string {
  const hasSlash = input.endsWith('/');
  if (hasSlash && !shouldAppend) {
    return input.substring(0, input.length - 1);
  } else if (!hasSlash && shouldAppend) {
    return `${input}/`;
  }
  return input;
}

function ensureLeadingSlash(input: string, shouldAppend: boolean): string {
  const hasSlash = input.startsWith('/');
  if (hasSlash && !shouldAppend) {
    return input.substring(1);
  } else if (!hasSlash && shouldAppend) {
    return `/${input}`;
  }
  return input;
}

// @needsAudit
/**
 * Create a URL that works for the environment the app is currently running in.
 * The scheme in bare and standalone must be defined in the app.json under `expo.scheme`.
 *
 * # Examples
 * - Bare: empty string
 * - Standalone, Custom: `yourscheme:///path`
 * - Web (dev): `https://localhost:19006/path`
 * - Web (prod): `https://myapp.com/path`
 * - Expo Client (dev): `exp://128.0.0.1:19000/--/path`
 * - Expo Client (prod): `exp://exp.host/@yourname/your-app/--/path`
 *
 * @param path addition path components to append to the base URL.
 * @param queryParams An object with a set of query parameters. These will be merged with any
 * Expo-specific parameters that are needed (e.g. release channel) and then appended to the URL
 * as a query string.
 * @param scheme Optional URI protocol to use in the URL `<scheme>:///`, when `undefined` the scheme
 * will be chosen from the Expo config (`app.config.js` or `app.json`).
 * @return A URL string which points to your app with the given deep link information.
 * @deprecated An alias for [`createURL()`](#linkingcreateurlpath-namedparameters). This method is
 * deprecated and will be removed in a future SDK version.
 */
export function makeUrl(path: string = '', queryParams?: QueryParams, scheme?: string): string {
  return createURL(path, { queryParams, scheme, isTripleSlashed: true });
}

// @needsAudit
/**
 * Helper method for constructing a deep link into your app, given an optional path and set of query
 * parameters. Creates a URI scheme with two slashes by default.
 *
 * The scheme in bare and standalone must be defined in the Expo config (`app.config.js` or `app.json`)
 * under `expo.scheme`.
 *
 * # Examples
 * - Bare: `<scheme>://path` - uses provided scheme or scheme from Expo config `scheme`.
 * - Standalone, Custom: `yourscheme://path`
 * - Web (dev): `https://localhost:19006/path`
 * - Web (prod): `https://myapp.com/path`
 * - Expo Client (dev): `exp://128.0.0.1:19000/--/path`
 * - Expo Client (prod): `exp://exp.host/@yourname/your-app/--/path`
 *
 * @param path Addition path components to append to the base URL.
 * @param namedParameters Additional options object.
 * @return A URL string which points to your app with the given deep link information.
 */
export function createURL(
  path: string,
  { scheme, queryParams = {}, isTripleSlashed = false }: CreateURLOptions = {}
): string {
  if (Platform.OS === 'web') {
    if (!Platform.isDOMAvailable) return '';

    const origin = ensureTrailingSlash(window.location.origin, false);
    let queryString = qs.stringify(queryParams);
    if (queryString) {
      queryString = `?${queryString}`;
    }

    let outputPath = path;
    if (outputPath) outputPath = ensureLeadingSlash(path, true);

    return encodeURI(`${origin}${outputPath}${queryString}`);
  }

  const resolvedScheme = resolveScheme({ scheme });

  let hostUri = getHostUri() || '';

  if (hasCustomScheme() && isExpoHosted()) {
    hostUri = '';
  }

  if (path) {
    if (isExpoHosted() && hostUri) {
      path = `/--/${removeLeadingSlash(path)}`;
    }
    if (isTripleSlashed && !path.startsWith('/')) {
      path = `/${path}`;
    }
  } else {
    path = '';
  }

  // merge user-provided query params with any that were already in the hostUri
  // e.g. release-channel
  let queryString = '';
  const queryStringMatchResult = hostUri.match(/(.*)\?(.+)/);
  if (queryStringMatchResult) {
    hostUri = queryStringMatchResult[1];
    queryString = queryStringMatchResult[2];
    let paramsFromHostUri = {};
    try {
      const parsedParams = qs.parse(queryString);
      if (typeof parsedParams === 'object') {
        paramsFromHostUri = parsedParams;
      }
    } catch {}
    queryParams = {
      ...queryParams,
      ...paramsFromHostUri,
    };
  }
  queryString = qs.stringify(queryParams);
  if (queryString) {
    queryString = `?${queryString}`;
  }

  hostUri = ensureLeadingSlash(hostUri, !isTripleSlashed);

  return encodeURI(
    `${resolvedScheme}:${isTripleSlashed ? '/' : ''}/${hostUri}${path}${queryString}`
  );
}

// @needsAudit
/**
 * Helper method for parsing out deep link information from a URL.
 * @param url A URL that points to the currently running experience (e.g. an output of `Linking.createURL()`).
 * @return A `ParsedURL` object.
 */
export function parse(url: string): ParsedURL {
  validateURL(url);

  const parsed = URL(url, /* parseQueryString */ true);

  for (const param in parsed.query) {
    parsed.query[param] = decodeURIComponent(parsed.query[param]!);
  }
  const queryParams = parsed.query;

  const hostUri = getHostUri() || '';
  const hostUriStripped = removePort(removeTrailingSlashAndQueryString(hostUri));

  let path = parsed.pathname || null;
  let hostname = parsed.hostname || null;
  let scheme = parsed.protocol || null;

  if (scheme) {
    // Remove colon at end
    scheme = scheme.substring(0, scheme.length - 1);
  }

  if (path) {
    path = removeLeadingSlash(path);

    let expoPrefix: string | null = null;
    if (hostUriStripped) {
      const parts = hostUriStripped.split('/');
      expoPrefix = parts.slice(1).concat(['--/']).join('/');
    }

    if (isExpoHosted() && !hasCustomScheme() && expoPrefix && path.startsWith(expoPrefix)) {
      path = path.substring(expoPrefix.length);
      hostname = null;
    } else if (path.indexOf('+') > -1) {
      path = path.substring(path.indexOf('+') + 1);
    }
  }

  return {
    hostname,
    path,
    queryParams,
    scheme,
  };
}

// @needsAudit
/**
 * Add a handler to `Linking` changes by listening to the `url` event type and providing the handler.
 * It is recommended to use the [`useURL()`](#useurl) hook instead.
 * @param type The only valid type is `'url'`.
 * @param handler An [`URLListener`](#urllistener) function that takes an `event` object of the type
 * [`EventType`](#eventype).
 * @return An EmitterSubscription that has the remove method from EventSubscription
 * @see [React Native Docs Linking page](https://reactnative.dev/docs/linking#addeventlistener).
 */
export function addEventListener(type: 'url', handler: URLListener): EmitterSubscription {
  return NativeLinking.addEventListener(type, handler);
}

/**
 * Remove a handler by passing the `url` event type and the handler.
 * @param type The only valid type is `'url'`.
 * @param handler An [`URLListener`](#urllistener) function that takes an `event` object of the type
 * [`EventType`](#eventype).
 * @see [React Native Docs Linking page](https://reactnative.dev/docs/linking#removeeventlistener).
 */
export function removeEventListener(type: 'url', handler: URLListener): void {
  NativeLinking.removeEventListener(type, handler);
}

// @needsAudit
/**
 * Helper method which wraps React Native's `Linking.getInitialURL()` in `Linking.parse()`.
 * Parses the deep link information out of the URL used to open the experience initially.
 * If no link opened the app, all the fields will be `null`.
 * > On the web it parses the current window URL.
 * @return A promise that resolves with `ParsedURL` object.
 */
export async function parseInitialURLAsync(): Promise<ParsedURL> {
  const initialUrl = await NativeLinking.getInitialURL();
  if (!initialUrl) {
    return {
      scheme: null,
      hostname: null,
      path: null,
      queryParams: null,
    };
  }

  return parse(initialUrl);
}

// @needsAudit
/**
 * Launch an Android intent with extras.
 * > Use [IntentLauncher](./intent-launcher) instead, `sendIntent` is only included in
 * > `Linking` for API compatibility with React Native's Linking API.
 * @platform android
 */
export async function sendIntent(action: string, extras?: SendIntentExtras[]): Promise<void> {
  if (Platform.OS === 'android') {
    return await NativeLinking.sendIntent(action, extras);
  }
  throw new UnavailabilityError('Linking', 'sendIntent');
}

// @needsAudit
/**
 * Open the operating system settings app and displays the app’s custom settings, if it has any.
 * @platform ios
 */
export async function openSettings(): Promise<void> {
  if (Platform.OS === 'web') {
    throw new UnavailabilityError('Linking', 'openSettings');
  }
  if (NativeLinking.openSettings) {
    return await NativeLinking.openSettings();
  }
  await openURL('app-settings:');
}

// @needsAudit
/**
 * Get the URL that was used to launch the app if it was launched by a link.
 * @return The URL string that launched your app, or `null`.
 */
export async function getInitialURL(): Promise<string | null> {
  return (await NativeLinking.getInitialURL()) ?? null;
}

// @needsAudit
/**
 * Attempt to open the given URL with an installed app. See the [Linking guide](/guides/linking)
 * for more information.
 * @param url A URL for the operating system to open, eg: `tel:5555555`, `exp://`.
 * @return A `Promise` that is fulfilled with `true` if the link is opened operating system
 * automatically or the user confirms the prompt to open the link. The `Promise` rejects if there
 * are no applications registered for the URL or the user cancels the dialog.
 */
export async function openURL(url: string): Promise<true> {
  validateURL(url);
  return await NativeLinking.openURL(url);
}

// @needsAudit
/**
 * Determine whether or not an installed app can handle a given URL.
 * On web this always returns `true` because there is no API for detecting what URLs can be opened.
 * @param url The URL that you want to test can be opened.
 * @return A `Promise` object that is fulfilled with `true` if the URL can be handled, otherwise it
 * `false` if not.
 *
 * The `Promise` will reject on Android if it was impossible to check if the URL can be opened, and
 * on iOS if you didn't [add the specific scheme in the `LSApplicationQueriesSchemes` key inside **Info.plist**](/guides/linking#opening-links-to-other-apps).
 */
export async function canOpenURL(url: string): Promise<boolean> {
  validateURL(url);
  return await NativeLinking.canOpenURL(url);
}

// @needsAudit
/**
 * Returns the initial URL followed by any subsequent changes to the URL.
 * @return Returns the initial URL or `null`.
 */
export function useURL(): string | null {
  const [url, setLink] = useState<string | null>(null);

  function onChange(event: { url: string }) {
    setLink(event.url);
  }

  useEffect(() => {
    getInitialURL().then((url) => setLink(url));
    const subscription = addEventListener('url', onChange);
    return () => subscription.remove();
  }, []);

  return url;
}

export * from './Linking.types';
export * from './Schemes';
