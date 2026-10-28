import useSWR from 'swr';

const fetcher = async (url, options = {}) => {
  const token = localStorage.getItem('token');
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Erro na requisição' }));
    throw error;
  }

  return response.json();
};

export const useAPI = (key, fetcherOptions = {}) => {
  const { data, error, isLoading, mutate } = useSWR(
    key ? key : null,
    (url) => fetcher(url, fetcherOptions),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
      dedupingInterval: 0,
      refreshInterval: 5000,
      errorRetryCount: 3,
    }
  );

  return {
    data,
    error,
    isLoading,
    mutate,
  };
};

export const useAPIMutation = (key) => {
  const { mutate } = useSWR(key);

  const trigger = async (body, options = {}) => {
    return mutate(
      async () => {
        const url = typeof key === 'string' ? key : key[0];
        const response = await fetch(url, {
          method: options.method || 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': localStorage.getItem('token'),
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Erro na requisição' }));
          throw error;
        }

        return response.json();
      },
      options
    );
  };

  return { trigger, isMutating: false };
};

export const fetchAPI = async (url, options = {}) => {
  const token = localStorage.getItem('token');
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Erro na requisição' }));
    throw error;
  }

  return response.json();
};

export default { useAPI, useAPIMutation, fetchAPI };
