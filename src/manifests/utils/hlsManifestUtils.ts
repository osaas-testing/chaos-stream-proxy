import { M3U, Manifest } from '../../shared/types';
import {
  newState,
  proxyPathBuilder,
  segmentUrlParamString
} from '../../shared/utils';
import { CorruptorConfigMap, IndexedCorruptorConfigMap } from './configs';
import clone from 'clone';

interface HLSManifestUtils {
  mergeMap: (
    segmentListSize: number,
    configsMap: IndexedCorruptorConfigMap
  ) => CorruptorConfigMap[];
}

export interface HLSManifestTools {
  createProxyMediaManifest: (
    originalM3U: M3U,
    sourceBaseURL: string,
    mutations: IndexedCorruptorConfigMap
  ) => Manifest; // look def again
  createProxyMasterManifest: (
    originalM3U: M3U,
    originalUrlQuery: URLSearchParams,
    stateKey: string | undefined
  ) => Manifest;
  utils: HLSManifestUtils;
}

export default function (): HLSManifestTools {
  const utils = Object.assign({
    mergeMap(
      segmentListSize: number,
      configsMap: IndexedCorruptorConfigMap
    ): CorruptorConfigMap[] {
      const corruptions = [...new Array(segmentListSize)].map(() => {
        const d = configsMap.get('*');
        if (!d) {
          return null;
        }
        const c: CorruptorConfigMap = new Map();
        for (const name of d.keys()) {
          const { fields } = d.get(name);
          c.set(name, { fields: { ...fields } });
        }

        return c;
      });

      // Populate any explicitly defined corruptions into the list
      for (let i = 0; i < corruptions.length; i++) {
        const configCorruptions = configsMap.get(i);

        if (configCorruptions) {
          // Map values always take precedence
          for (const name of configCorruptions.keys()) {
            if (!corruptions[i]) {
              corruptions[i] = new Map();
            }

            // If fields isn't set, it means it's a skip if *, otherwise no-op
            if (!configCorruptions.get(name).fields) {
              corruptions[i].delete(name);
              continue;
            }

            corruptions[i].set(name, configCorruptions.get(name));
          }
        }

        // If we nooped anything, let's make sure it's null
        if (!corruptions[i]?.size) {
          corruptions[i] = null;
        }
      }

      return corruptions;
    }
  });

  return Object.assign({
    utils,
    createProxyMasterManifest(
      originalM3U: M3U,
      originalUrlQuery: URLSearchParams,
      stateKey: string | undefined
    ) {
      const m3u: M3U = clone(originalM3U);

      // [Video]
      let abrLevel = 1;
      m3u.items.StreamItem = m3u.items.StreamItem.map((streamItem) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bitRate = (streamItem as any)?.attributes?.attributes?.bandwidth;
        const currentUri = streamItem.get('uri');
        // Clone params to avoid mutating input argument
        const urlQuery = new URLSearchParams(originalUrlQuery);
        if (bitRate) {
          urlQuery.set('bitrate', bitRate);
          urlQuery.set('level', abrLevel.toString());
          abrLevel++;
        }
        if (stateKey) {
          urlQuery.set('state', stateKey);
        }
        streamItem.set(
          'uri',
          proxyPathBuilder(currentUri, urlQuery, 'proxy-media.m3u8')
        );
        return streamItem;
      });

      // [Audio/Subtitles/IFrame]
      m3u.items.MediaItem = m3u.items.MediaItem.map((mediaItem) => {
        const urlQuery = new URLSearchParams(originalUrlQuery);
        const currentUri = mediaItem.get('uri');
        // #EXT-X-MEDIA URI,is only required with type SUBTITLES, optional for AUDIO and VIDEO
        if (mediaItem.get('type') !== 'SUBTITLES' && currentUri == undefined) {
          return mediaItem;
        }

        if (stateKey) {
          urlQuery.set('state', stateKey);
        }
        mediaItem.set(
          'uri',
          proxyPathBuilder(currentUri, originalUrlQuery, 'proxy-media.m3u8')
        );
        return mediaItem;
      });

      return m3u.toString();

      //---------------------------------------------------------------
      // TODO: *Edge case*, cover case where StreamItem.get('uri')
      // is a http://.... url, and not a relative
      //---------------------------------------------------------------
    },
    createProxyMediaManifest(
      originalM3U: M3U,
      sourceBaseURL: string,
      configsMap: IndexedCorruptorConfigMap
    ) {
      const m3u: M3U = clone(originalM3U);

      // configs for each index
      const corruptions = this.utils.mergeMap(
        m3u.items.PlaylistItem.length,
        configsMap
      );

      // Attach corruptions to manifest
      for (let i = 0; i < m3u.items.PlaylistItem.length; i++) {
        const item = m3u.items.PlaylistItem[i];
        const corruption = corruptions[i];
        let sourceSegURL: string = item.get('uri');
        if (!sourceSegURL.match(/^http/)) {
          sourceSegURL = `${sourceBaseURL}/${item.get('uri')}`;
        }

        if (!corruption) {
          item.set('uri', sourceSegURL);
          continue;
        }

        const params = segmentUrlParamString(sourceSegURL, corruption);
        item.set(
          'uri',
          proxyPathBuilder(
            item.get('uri'),
            new URLSearchParams(params),
            '../../segments/proxy-segment'
          )
        );
      }
      return m3u.toString();
    }
  });
}
