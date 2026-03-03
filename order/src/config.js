require('dotenv').config();

module.exports = {
    mongoURI: process.env.MONGODB_ORDER_URI || 'mongodb://localhost/orders',
    rabbitMQURI: process.env.RABBITMQ_URL || 'amqp://localhost',
    rabbitMQQueue: 'orders',
    port: process.env.PORT || 3002
};
