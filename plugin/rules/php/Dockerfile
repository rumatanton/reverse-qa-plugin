# reverse-qa PHP rule pack image: PHP-Parser (the extractor) and Psalm (taint analysis), locked by composer.lock.
# The extractor script is mounted at run time from plugin/rules/php, so editing it needs no rebuild.
FROM composer:2.11.1@sha256:8de2184c6de224f4689e8f80ed5f5edaf0030b6b8b7839a22a2bcb6722ac87d0
WORKDIR /opt/tools
COPY composer.json composer.lock ./
RUN composer install --no-interaction --no-progress --no-scripts --prefer-dist
ENV PATH="/opt/tools/vendor/bin:${PATH}"
WORKDIR /work
