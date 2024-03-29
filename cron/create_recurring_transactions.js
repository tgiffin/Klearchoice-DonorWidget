#!/usr/bin/env node
/**
 *  create_recurring_transactions.js
 *
 *  Create recurring transactions from the subscription table.
 *
 *  This script follows the following steps:
 *
 *  1) Gather all records which have a transaction which is due today
 *  2) Create the transaction record in the transactions table
 *  3) Calculate the date for the next transaction and update the row in the subscription table
 *
 *  History
 * 
 *  Date        Author                                  Comments
 *  ---------------------------------------------------------------------------------
 *  5/26/2013   Clay Gulick (clay@ratiosoftware.com)    Initial version created
 */
var conf = new require("../config.js")();
var dal = require("../dal"); //data access layer
var q = require("q");
var log = conf.logger;
log.name("create_recurring_transactions.js");
var util = require("util");
var payment = require("../payment.js");
var getNextSubscriptionDate = require("../helpers").getNextSubscriptionDate;

log.log("Start create_recurring_transactions.js...");
dal.open();
dal.get_current_recurring_transactions(
  function(err,rows)
  {

    var promises = []; //promises, promises

    if(err)
      return log.error(util.inspect(err));

    log.log("Processing " + rows.length + " rows...");
    rows.forEach(
      function(item, index, arr)
      {
        item.d = q.defer();
        promises.push(item.d.promise);
        log.log("Creating transaction - donor id: " + item.donor_id + " charity id: " + item.charity_id + " amount: " + item.amount + " frequency: " + item.frequency);
	debugger;
        dal.log_transaction(
          {
            donor_id: item.donor_id,
            charity_id: item.charity_id,
            amount: item.amount,
            klearchoice_fee: payment.dwolla.klearchoice_fee(item.amount),
            processor_fee: payment.dwolla.processor_fee(item.amount),
            status: "new",
            message: (new Date()).toString() + " recurring transaction created from subscription: " + item.id,
            log: (new Date()).toString() + " recurring transaction created from subscription: " + item.id
          },
          function(err, result)
          {
            if(err)
              log.error("Error creating transaction: " + util.inspect(err));

            update_subscription(item);
          });
      });
    q.allResolved(promises).then(
      function(params)
      {
        dal.close();
        log.log("Completed processing transactions");
      });

  });

/**
 * Calculate the next_transaction_date for the subscription based on frequency
 * Valid frequency values are:
 * daily
 * weekly
 * biweekly
 * monthly
 */
function update_subscription(subscription)
{
  var update = {};
  update.id=subscription.id;
  update.next_transaction_date = date_string(getNextSubscriptionDate(subscription.frequency, subscription.create_date));
  update.last_transaction_date = date_string(new Date());

  dal.update_subscription(update,
    function(err,result)
    {
      if(err)
        log.error("Error updating subscription: " + util.inspect(err));
      dal.close();
    });
}

/**
 * Returns a formatted my-sql compliant date string with no time component
 */
function date_string(d)
{
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

