# Vitrine Video Commerce Engine

Base local de desenvolvimento com Next.js, API Go, worker de campanhas, MySQL e Redis.

## Executar com Docker Compose

Requisitos: Docker Engine e Docker Compose v2.

```sh
cp .env.example .env
docker compose up --build
```

Abra `http://localhost:3000`. A interface usa a API pelo proxy same-origin. A API de desenvolvimento também fica disponível em `http://localhost:8080`; MySQL e Redis permanecem somente na rede interna do Compose.

O Compose aguarda MySQL e Redis saudáveis, aplica as migrações e então inicia API, worker e web. Novas campanhas persistem no MySQL; fotos ficam no volume `uploads`. Os dados sobrevivem a `docker compose down` e à recriação dos containers.

Para parar sem remover os dados:

```sh
docker compose down
```

Remover os volumes com `docker compose down --volumes` apaga campanhas, imagens e dados do Redis.

## Limites desta base

O worker gera roteiro, legenda e CTA demonstrativos; ele não renderiza MP4 nem chama um provedor de IA. Credenciais do `.env.example` servem apenas para desenvolvimento local. Esta base ainda não inclui autenticação, autorização, billing ou controles para exposição pública e não deve ser implantada na internet sem esses recursos.
