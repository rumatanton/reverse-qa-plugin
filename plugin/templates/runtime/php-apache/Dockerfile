# syntax=docker/dockerfile:1
# Generic PHP + Apache runtime for reverse-qa PHP targets. The app is copied from the "app" build context (the clone);
# the clone is never mounted, so uploads made during tests stay inside the container.
# Build args: PHP_IMAGE (version under test), APP_PATH (URL path the app is served under; empty = web root),
# WRITABLE_DIRS (space-separated folders, relative to the app, that the app writes to at run time).
ARG PHP_IMAGE=php:7.2-apache
FROM ${PHP_IMAGE}

RUN docker-php-ext-install mysqli

# Start from the development php.ini (output_buffering=4096, as in a XAMPP-style install), then apply our overrides.
RUN cp "$PHP_INI_DIR/php.ini-development" "$PHP_INI_DIR/php.ini"
COPY php-overrides.ini "$PHP_INI_DIR/conf.d/zz-reverse-qa.ini"

# Declared late so changing them does not invalidate the cached layers above.
ARG APP_PATH=
ARG WRITABLE_DIRS=
RUN --mount=type=bind,from=app,target=/src \
    dest="/var/www/html/${APP_PATH}" \
 && mkdir -p "$dest" \
 && cp -a /src/. "$dest/" \
 && rm -rf "$dest/.git" \
 && for d in $WRITABLE_DIRS; do mkdir -p "$dest/$d" && chown -R www-data:www-data "$dest/$d"; done \
 && mkdir -p /var/log/php \
 && chown www-data:www-data /var/log/php
