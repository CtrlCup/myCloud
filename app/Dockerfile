FROM node:20-alpine

RUN apk add --no-cache ffmpeg exiftool tesseract-ocr tesseract-ocr-data-deu tesseract-ocr-data-eng poppler-utils rsvg-convert

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]
