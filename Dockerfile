ARG IMAGE1
FROM $IMAGE1
COPY ./ /var/app/
RUN npm i
RUN npm audit fix
RUN npm run build
EXPOSE 80
CMD ["npm", "start"]
