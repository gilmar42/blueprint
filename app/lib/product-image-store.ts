const DATABASE_NAME = "vitrine-product-images";
const STORE_NAME = "images";
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("Este navegador não oferece armazenamento local de imagens."));
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Não foi possível abrir o armazenamento de imagens."));
    request.onblocked = () => reject(new Error("O armazenamento de imagens está ocupado em outra aba."));
  });
}

export async function saveProductImage(key: string, image: Blob): Promise<void> {
  const database = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(image, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Não foi possível salvar a imagem do produto."));
    transaction.onabort = () => reject(transaction.error ?? new Error("O salvamento da imagem foi interrompido."));
  }).finally(() => database.close());
}

export async function getProductImage(key: string): Promise<Blob | null> {
  const database = await openDatabase();

  return new Promise<Blob | null>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    let image: Blob | null = null;

    request.onsuccess = () => {
      image = request.result instanceof Blob ? request.result : null;
    };
    request.onerror = () => reject(request.error ?? new Error("Não foi possível recuperar a imagem do produto."));
    transaction.oncomplete = () => resolve(image);
    transaction.onerror = () => reject(transaction.error ?? new Error("Não foi possível recuperar a imagem do produto."));
  }).finally(() => database.close());
}

export async function deleteProductImage(key: string): Promise<void> {
  const database = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Não foi possível remover a imagem do produto."));
    transaction.onabort = () => reject(transaction.error ?? new Error("A remoção da imagem foi interrompida."));
  }).finally(() => database.close());
}
