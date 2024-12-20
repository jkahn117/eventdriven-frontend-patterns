// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import middy from "@middy/core";
import { Logger } from "@aws-lambda-powertools/logger";
import { parser } from "@aws-lambda-powertools/parser/middleware";
import { KinesisEnvelope } from "@aws-lambda-powertools/parser/envelopes"
import { FlightData, FlightDataStreamSchema } from "../../lib/flight";


/**
 * @typedef { import('@types/aws-lambda') }
 * @typedef { import('@aws-sdk/client-dynamodb') }
 * @typedef { import('@aws-sdk/lib-dynamodb') }
 * @typedef { import('../../lib/flight') }
 */

const { ConnectionsTable, WebsocketEndpoint, AWS_REGION } = process.env;

const logger = new Logger();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION}));

let apigw;


/**
 * Gets the list of connection IDs that point to subscribers.
 * @returns array of subscriber connection IDs
 */
const getSubscribers = async() => {
  let subscribers = [];

  try {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: ConnectionsTable,
        ProjectionExpression: "connectionId"
      })
    );

    subscribers = resp.Items;
  } catch(err) {
    logger.error(`Could not load subscribers: ${JSON.stringify(err)}`);
  }

  return subscribers;
};

/**
 * 
 * @param {*} subscribers 
 * @param {*} payload 
 */
const publishUpdateToSubscribers = async(subscribers, payload) => {
  await Promise.all(
    subscribers.map(async (sub) => {
      try {
        logger.info(`Publish to connect id: ${sub.connectionId}`);
        await apigw.send(
          new PostToConnectionCommand({
            Data: JSON.stringify(payload),
            ConnectionId: sub.connectionId
          })
        );
      } catch (err) {
        if (err.statusCode === 410) {
          logger.info(`Found stale connection: ${sub.connectionId}`);
          await ddb.send(
            new DeleteCommand({
              TableName: ConnectionsTable,
              Key: {
                connectionId: sub.connectionId
              }
            })
          )
        } else {
          throw err;
        }
      }
    })
  );
};

/**
 * 
 * @param {import("@types/aws-lambda").KinesisStreamEvent} event 
 * @param {import("@types/aws-lambda/handler").Context} _ 
 */
export const handler = middy(async(event, _) => {
  logger.debug(event);

  // init API GW client as we need info from context
  apigw = new ApiGatewayManagementApiClient({ endpoint: WebsocketEndpoint });

  // TODO: add support to only get subscribers for a single flight
  const subscribers = await getSubscribers();

  let batchItemFailures = [];
  for (let record of event.values()) {
    try {
      const flight = FlightData.fromStream(record.dynamodb.NewImage);

      const payload = flight.toJson();

      if (record.eventName === "MODIFY") {
        payload.operation = "UPDATE";
      } else if (record.eventName === "INSERT") {
        payload.operation = "CREATE";
      }

      await publishUpdateToSubscribers(subscribers, payload);
    } catch (err) {
      logger.error('Operation failed');
      logger.error(err);
      batchItemFailures.push({ "itemIdentifier": record.dynamodb.SequenceNumber })
    }
  }

  return {
    batchItemFailures
  }
}).use( parser({ schema: FlightDataStreamSchema, envelope: KinesisEnvelope }));