# Vitrine Video Commerce Engine

Aplicação com Next.js, backend Node.js, worker de campanhas, MySQL e Redis. Inclui cadastro, login, sessões por cookie e recuperação de senha por SMTP.

## Executar com Docker Compose

Requisitos: Docker Engine e Docker Compose v2.

```sh
cp .env.example .env
docker compose up --build
```

Abra `http://localhost:3000`. A interface usa a API pelo proxy same-origin. A API de desenvolvimento também fica disponível em `http://localhost:8080`; MySQL e Redis permanecem somente na rede interna do Compose.

O Compose aguarda MySQL e Redis saudáveis, aplica as migrações e então inicia API, worker e web. Novas campanhas persistem no MySQL; fotos ficam no volume `uploads`. Os dados sobrevivem a `docker compose down` e à recriação dos containers.

## Executar com o banco do XAMPP

O backend também pode usar o MySQL/MariaDB fornecido pelo XAMPP. As migrações usam `utf8mb4_unicode_ci`, JSON, chaves estrangeiras e datas com microssegundos, compatíveis com MySQL 8 e MariaDB 10.11. O executor cria todas as tabelas da aplicação e o tenant inicial: `tenants`, `projects`, `render_jobs`, `users`, `auth_sessions`, `password_reset_tokens` e `user_uploads`.

1. Inicie o serviço **MySQL** no painel do XAMPP e confirme a porta (padrão `3306`).
2. Na raiz do projeto, copie `xampp.env.example` para `.env` e ajuste host, porta e credenciais, se necessário. O XAMPP costuma usar `root` sem senha em instalações locais.
3. Instale as dependências e prepare o banco:

   ```sh
   npm ci --prefix backend
   npm run xampp:create-db
   npm run xampp:migrate
   ```

4. O perfil XAMPP usa uma fila MySQL (`QUEUE_DRIVER=mysql`), então não precisa iniciar Redis nem Docker.
5. Configure `OPENAI_API_KEY` no `.env` para habilitar os roteiros reais. Em terminais separados, inicie API, worker e interface:

   ```sh
   npm run xampp:api
   npm run xampp:worker
   npm run dev
   ```

Abra `http://localhost:3000`. Envie de 20 a 40 fotos nítidas do produto, cobrindo todos os lados; o worker usa COLMAP e OpenMVS para reconstruir uma malha 3D texturizada e Blender para renderizar uma volta de 18 segundos. O FFmpeg compõe o MP4 H.264 com o roteiro e a legenda. O projeto também disponibiliza o arquivo 3D GLB para download. Fotos com pouca sobreposição, reflexos fortes ou superfícies sem textura podem impedir uma boa reconstrução. O modo CPU funciona sem GPU CUDA, mas pode demorar bastante.

A OpenAI gera os roteiros pela Responses API. É possível informar um texto base opcional; o sistema organiza esse conteúdo em um roteiro profissional, claro e objetivo, sem inventar características do produto. O vídeo e o modelo 3D ficam salvos no servidor e são acessados pela conta proprietária. As credenciais de `.env` são somente para desenvolvimento local; o arquivo é ignorado pelo Git. Para apontar para uma base existente, defina `DB_NAME` para essa base antes de executar as migrações. Faça backup antes de aplicar mudanças em dados existentes.

## Preparar uma implantação pública

O Compose fornece os serviços da aplicação, mas não termina TLS. Publique o serviço `web` atrás de um proxy HTTPS (por exemplo, Caddy, Nginx ou um balanceador gerenciado), encaminhe somente para `127.0.0.1:3000` e mantenha a API, MySQL e Redis inacessíveis pela internet. Configure o DNS e certificados no proxy antes de habilitar produção. Use o override de produção para impedir inicialização com credenciais locais ou ausentes:

```sh
docker compose -f compose.yaml -f compose.production.yaml up --build -d
```

O override exige as variáveis de produção da seção abaixo, valida a força e a separação das senhas, e força `APP_ENV=production` e cookies seguros. Elas podem vir de um `.env` fora do repositório ou do gerenciador de segredos da plataforma.

No `.env`, defina `APP_ENV=production`, `APP_BASE_URL=https://seu-dominio`, `AUTH_COOKIE_SECURE=1`, `OPENAI_API_KEY` e senhas únicas e fortes para MySQL, MySQL root e Redis. Configure `SMTP_ADDRESS` como `host:587` com STARTTLS, além de `SMTP_USERNAME`, `SMTP_PASSWORD` e `SMTP_FROM`. O backend recusa iniciar em produção se esses valores estiverem ausentes, se a URL pública não for HTTPS ou se forem mantidas as senhas locais padrão. Guarde `.env` em um gerenciador de segredos e não o inclua no controle de versão.

O cookie de sessão de produção é `__Host-vitrine_session`, `Secure`, `HttpOnly` e `SameSite=Lax`. A API também verifica a origem das requisições de escrita e adiciona cabeçalhos de segurança. Para que os limites internos usem o endereço correto, o proxy de borda precisa sobrescrever `X-Real-IP` com o IP do cliente; não aceite esse cabeçalho diretamente da internet. Configure também limites por IP no proxy público, principalmente ao usar múltiplas réplicas.

Cada usuário é proprietário dos próprios projetos e imagens; a API impede ler ou reutilizar imagens de outra conta e limita uploads a 500 MB por conta. As migrações `003_project_ownership.sql` e `004_user_uploads.sql` atribuem projetos existentes ao primeiro usuário do tenant quando houver um; projetos sem usuário existente ficam sem proprietário e não aparecem nas contas novas. Faça backup do MySQL antes da primeira migração em uma instalação com dados existentes.

Antes de liberar tráfego, configure backups e restauração do MySQL e do volume `uploads`, monitoramento de erros, rotação de credenciais SMTP/DB/Redis e uma política de privacidade. O e-mail de recuperação contém um link de uso único que expira em 30 minutos; tokens não são gravados nos logs.

Para parar sem remover os dados:

```sh
docker compose down
```

Remover os volumes com `docker compose down --volumes` apaga campanhas, imagens e dados do Redis.

O billing interno não está habilitado. Chamadas à OpenAI podem gerar custos na conta associada à chave. O worker detecta encoders H.264 disponíveis no FFmpeg e usa `libx264`, `libopenh264` ou MPEG-4 como alternativa; instale um build do FFmpeg com suporte a H.264 para máxima compatibilidade dos arquivos.

## Limites desta base

A autenticação implementada não inclui verificação de e-mail, MFA ou gerenciamento de sessões por dispositivo. Não inclui narração nem música. Use um proxy com limites por IP e monitore a implantação; a configuração de produção endurece a aplicação, mas não substitui operação, backups e resposta a incidentes.
