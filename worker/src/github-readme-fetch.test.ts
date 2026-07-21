import { afterEach, describe, expect, test, vi } from 'vitest';

import { fetchGithubReadme } from './github';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubReadmeFetch(
  responder: (url: string, call: number) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return responder(url, call++);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('GitHub README fetch status', () => {
  test('network failures remain retryable instead of becoming confirmed absence', async () => {
    stubReadmeFetch(async (_url, call) => {
      if (call === 0) throw new Error('socket reset');
      return new Response('', { status: 404 });
    });

    await expect(fetchGithubReadme('octo', 'repo', 'main')).rejects.toThrow(
      /README fetch failed.*socket reset/i,
    );
  });

  test.each([429, 500, 503])(
    'HTTP %s remains retryable instead of becoming confirmed absence',
    async (status) => {
      stubReadmeFetch(async () => new Response('', { status }));

      await expect(fetchGithubReadme('octo', 'repo', 'main')).rejects.toThrow(
        new RegExp(`README fetch HTTP ${status}`),
      );
    },
  );

  test('only explicit 404 and empty successful files produce confirmed absence', async () => {
    const fetcher = stubReadmeFetch(async (_url, call) => (
      call % 2 === 0
        ? new Response('', { status: 404 })
        : new Response('   \n', { status: 200 })
    ));

    await expect(fetchGithubReadme('octo', 'repo', 'main')).resolves.toEqual({
      status: 'confirmed_absent',
      content: '',
      branch: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  test('a non-empty successful README reports found with the resolved branch', async () => {
    stubReadmeFetch(async (url) => (
      url.endsWith('/master/README.md')
        ? new Response('# Working README', { status: 200 })
        : new Response('', { status: 404 })
    ));

    await expect(fetchGithubReadme('octo', 'repo', 'main')).resolves.toEqual({
      status: 'found',
      content: '# Working README',
      branch: 'master',
    });
  });
});
