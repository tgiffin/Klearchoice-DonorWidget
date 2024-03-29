var console = require("console");
var payment = require("./payment").dwolla; //payment processor
var dal = require("./dal"); //data access layer
var fs = require("fs");
var Config = require("./config");
var conf = new Config();
var log = conf.logger;
var accounting = require("./lib/accounting");
var URI = require("./lib/URI/URI");
var crypto = require('crypto');
var util = require("util");
var rsa = require("./crypt"); //this is the utility function for rsa encryption of account details
var templates = require("./templates").templates;
var Recaptcha = require("recaptcha").Recaptcha; 
var Mandrill = require("mandrill-api").Mandrill;
var mandrill = new Mandrill(
  conf.mandrill_api_key, //the api key to use
  conf.env=="development" //whether debugging output should be logged
);
var getNextSubscriptionDate = require("./helpers").getNextSubscriptionDate;

/*********************************************************************************************
 * Templates / pages 
 *
 * These are the logic behind the actual html pages that are rendered upon user request
 *********************************************************************************************/

/**
 * This is the starting page
 */ 
exports.donor_widget = function(request, response, next)
  {
    var referer = request.headers['referer'];
    var parsedURI = URI.parse(referer);
    log.debug("referer: " + referer + " hostname: " + parsedURI.hostname);
    //log.debug("locating base domain: " + parsedURI.hostname.split(".").slice(-2).join("."));
    dal.open();
    dal.get_charity_by_domain(parsedURI.hostname.split(".").slice(-2).join("."),
      function(err, row)
      {
        dal.close();

        if(err) { next(err); return; }

        if(!row)
        {
          response.redirect(conf.hostname + "/html/donor_widget_invalid_configuration.html");   
          return; 
        }

        request.session.charity = info = row;
        response.send(templates['donor_widget.html']( 
        {
          charity_name: row.charity_name
        }));
      });

  }


/**
 * This is the Charity registration page. Currently it just loads the static template,
 * however in the future server-side logic may occur, so it is implemented as an action
 */
exports.register = function(request, response)
{
    response.send(templates['register.html'](
      {
      }));
}

/**
 * Load the user's profile page
 */
exports.profile = function(request, response)
{
    response.send(templates['profile.html'](
      {
        authenticated: request.session.auth ? true : false,
        recaptcha_public_key: conf.recaptcha_public_key
      }));
}

/**
 * Render the password reset form. Store the passed in token in the session
 * for later verification.
 */
exports.reset_password = function(request, response)
{
  var token = request.query["token"];
  if(token) token = escapeHtml(token);
  request.session["reset_token"]=token; //this will be verified later, when the actual password reset call is made
  
  response.send(templates['reset_password.html'](
    {
    }));
}


/*********************************************************************************************
 * API Service calls
 *
 * These are semi-RESTful api calls that are called from the browser or client
 *********************************************************************************************/

/**
 * Send out password recovery email.
 *
 * This does the following things:
 * 1) Generates reset token (guid) and stores it in the password_recovery_token field along with the password recovery date
 * 2) Sends email with recovery link
 */
exports.recover_password = function(request, response)
{
  var uuid = require("node-uuid");
  var token = uuid.v4();

  dal.open();
  dal.get_donor({email:request.body.email},
    function(err, donor)
    {
      if(err)
      {
          console.error(err);
          response.json(
            {
              success: false,
              message: "Database error querying donor record"
            });
          return;
      }
      if(!donor)
      {
          response.json(
            {
              success: false,
              message: "Unknown email address"
            });
          return;
      }
      //format a mysql date
      var date;
      date = new Date();
      date = date.getUTCFullYear() + '-' +
        ('00' + (date.getUTCMonth()+1)).slice(-2) + '-' +
        ('00' + date.getUTCDate()).slice(-2) + ' ' + 
        ('00' + date.getUTCHours()).slice(-2) + ':' + 
        ('00' + date.getUTCMinutes()).slice(-2) + ':' + 
        ('00' + date.getUTCSeconds()).slice(-2);
      //update the donor with the recovery token and time
      dal.update_donor(
        {
          id: donor.id,
          password_recovery_token: token,
          password_recovery_date: date
        },
        function(err)
        {
          if(err)
          {
            response.json(
              {
                success:false,
                message:"Error querying database"
              });
              return;
          }

          try
          {
            log.debug("sending password recovery email...");
            mandrill.messages.sendTemplate(
              {
                template_name:"loginrecovery",
                template_content: [
                  {name:"reset_link", content:"<a href='https://app.klearchoice.com/reset_password.html?token=" + token + "'>reset password</a>"},
                ],
                message: {
                  to: [
                        {email:donor.email, name:donor.first_name + " " + donor.last_name}
                      ],
                  tracking_domain: "klearchoice.com"
                }

              },
              function(){log.debug("email sent successfully");}, //success, do nothing
              function(err){console.error(util.inspect(err));} //error
              );
          }
          catch(e) { console.error("error sending email: " + util.inspect(e)); }

          response.json(
            {
              success: true
            });
        }); //end update donor
    }); //end get_donor
} //end recover_password

/**
 * API call to reset user password.
 *
 * In order for this to work, a token must already be in the session, otherwise an error will
 * be returned. 
 */
exports.set_password = function(request, response)
{
  //first, grab the token out of the session and validate it
  var token = request.session["reset_token"];
  var password = request.body["password"]; 
  if(!token) 
    return response.json(   
      {
        success: false, 
        message: "Missing or invalid token"
      });
  dal.open();
  //get the donor record based on the token
  dal.get_donor_by_token(token, 
    function(err,donor)
    {
      if(err || !donor)
        return response.json({
          success: false,
          message: "Invalid token"
        });
      //check to see if the token has expired
      var date = donor.password_recovery_date;
      var ticks = (new Date()).getTime() - date.getTime();
      if(ticks > 1000 * 60 * 60 * 24) //been longer than a day?
        return response.json(
          {
            success: false,
            message: "Expired token"
          });
      
      //create salt and encrypted password
      var salt = crypto.randomBytes(128).toString('base64');
      var encrypted_password = crypto.pbkdf2Sync(password,salt,5000,256).toString('base64');
      
      //burn the token so it can't be reused
      //update the donor with the recovery token and time
      dal.update_donor(
        {
          id: donor.id,
          password: encrypted_password,
          salt: salt,
          password_recovery_token: "",
          password_recovery_date: null
        },
        function(err)
        {
          if(err)
            return response.json(
              {
                success:false,
                message: "Error updating donor"
              });

          //TODO: send notification email that the password has been reset

          //send a success response
          return response.json(
            {
              success:true,
              message: ""
            });
        });

    });

  
}

/**
 * This is the main donation function called from the donor widget
 *
 * This can be called in a couple of different ways, and will do different things depending
 * how it is called.
 *
 * If it is called with an authenticated user in session (request.session.auth) 
 * then a payment is created with the existing donor account information. The payment record
 * will be picked up later by the payment server's batch job process and sent for processing. In this case,
 * it is also possible that a recurring donation was selected. If so, a recurring transaction
 * record for the donor will also be created.
 *
 * If it is called without an authenticated user, then all donor informaion is gathered from the post
 * body and validated. A payment record will be created in the database, but the transaction will be sent
 * to the processor immediately so that we don't store any of the user's sensitive information.
 * In this case, it is also possible that the user is requesting that we create an 
 * account (body.create_account == true). If so, we validate that the terms were accepted and 
 * save the account information. Even if a membership was created, for this initial donation the
 * payment is processed immediately and sent to dwolla. This is so that there aren't conflicts
 * between the time the payment record is inserted into the database, picked up by the payment job
 * and sent for process and when the new account file is picked up by the incoming accounts job.
 * 
 * Subsequent donations made for the stored account will follow the flow for authenticated users above.
 *
 * When creating an account, only non-sesitive information is stored in the database. For the secure
 * bank account information, we create and encrypted file and sftp it over to the payment server. The
 * payment server will pick up the new file and keep it in the proper secure storage location.
 */
exports.donate = function(request, response)
{
  var data = {};
  
  //cleanse input for xss. sqli is dealt with via parameterized commands in the dal
  for(var key in request.body) { data[key] = escapeHtml(request.body[key]); }

  //if this is an authenticated user, just create the transaction, it will be picked up by the 
  //payment server later
  if(request.session.auth)
  {
    dal.open();
    dal.log_transaction(
      {
        donor_id: request.session.auth.id,
        charity_id: request.session.charity.id,
        amount: data.amount,
        klearchoice_fee: payment.klearchoice_fee(data.amount),
        processor_fee: payment.processor_fee(data.amount),
        status: "new",
        log: (new Date()).toString() + "Transaction created \n"
      },
      function(err,result)
      {
        dal.close();
        if(err)
        {
          response.json(
            {
              success: false,
              message: "Unable to add payment transaction"
            });
          return;
        }

        response.json(
          {
            success:true
          });
      });

    return;
  }//end if auth user

  //let's validate the information that was sent to us
  //sqli is dealt with by the dal, and this has already been cleansed for xss
  var valid = true;
  var message = "Invalid data";
  if(!data.first_name) valid=false;
  if(!data.last_name) valid=false;
  if(!data.email) valid = false;
  if(!data.confirm_email || (data.email != data.confirm_email)) valid=false;
  if(!data.amount) valid=false;
  var amt = parseFloat(data.amount);
  if(isNaN(amt)) valid=false;
  else
  {
    if(amt > 1000)
    {
      valid=false;
      message = "Please enter an amount less than $1000";
    }
  }

  if(valid==false)
  {
    response.json(
      {
        success: false,
        message: message
      });
      return;
  }

  //this is an unauthenticated user. First, let's create the donor record.
  //we always add a new donor record, even if there is an existing donor
  //with this email. This is to prevent a possible security exploit where
  //a malicious user could change data in the database by doing unauthenticated
  //service calls with email addresses.
  var donor = 
    {
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email
    };
  if(data.create_account=='true')
  {
    //before we can create the record, we need to create the salt and encrypt the password
    var salt = crypto.randomBytes(128).toString('base64');
    var encrypted_password = crypto.pbkdf2Sync(data.password,salt,5000,256).toString('base64');
    donor.password = encrypted_password;
    donor.salt = salt;
    donor.member = 1;

  }
  log.debug("adding donor...");
  dal.open(); 
  dal.add_donor(donor,
    function(err,result)
    {
      if(err)
      {
        dal.close();
        console.log(err);
        response.json(
          {
            success: false,
            message: "Unable to add donor"
          });
          return;
      }

      //the newly inserted donor id
      var donor_id = result.insertId;

      //if we're creating an account, send the secure account file over
      if(data.create_account=='true')
      {
        log.debug("sending secure user file...");
        create_secure_account_file(
          {
            donor_id: donor_id,
            first_name: donor.first_name,
            last_name: donor.last_name,
            email: donor.email,
            account: {
              account_number: data.account_number,
              routing_number: data.routing_number,
              account_type: data.account_type
            }
          },
          function(err)
          {
            if(err)
            {
              console.error(err);
              response.json(
              {
                success: false,
                message: "We're sorry, there was an error creating the secure account, this transaction has been canceled. Please try your donation again later. If this problem persists, please contact your organization to report the issue."
              });
              return;
            }
            //the account creation succeeded, send the dwolla payment
            send_payment(request,response,data,donor_id);
          });
      }
      else
      {
        send_payment(request,response,data,donor_id);
      }
  
    });//end add donor
}//end guest_send


/**
 * Return JSON packets that indicated whether the user is currently logged in
 */
exports.is_auth = function(request, response)
{
  if(request.session.auth)
  {
    response.json(
      {
        auth: true, 
        donor_id: request.session.auth.id,
        first_name: request.session.auth.first_name,
        last_name: request.session.auth.last_name,
        email: request.session.auth.email
      }
    );
  }
  else
  {
    response.json(
      {
        auth: false
      }
    );
  }
}

//this is a tracker that keeps a tally of the auth requests per IP address
var auth_requests = [];
/**
 * Authenticate user and store info in auth session variable
 */
exports.auth = function(request, response, next)
{
  var credentials={};
  for(var key in request.body) { credentials[key] = escapeHtml(request.body[key]); }
  
  var ip = request.connection.remoteAddress;
  var require_captcha=false;

  if(auth_requests[ip])
  {
    var ticks = (new Date()).getTime() - auth_requests[ip].last_attempt.getTime();
    if(ticks > 1000 * 60 * 5) //been 5 mins?
    {
      //reset attempts
      auth_requests[ip].attempts=0;
    }
    auth_requests[ip].attempts++;
    auth_requests[ip].last_attempt=new Date();
  }
  else
    auth_requests[ip] = {attempts:1,last_attempt:new Date()};

  if(auth_requests[ip].attempts > 3)
  {
    require_captcha=true;
    console.log("exceed max trials for ip: " + ip + " requiring captcha.");
  }

  function validate_auth()
  {
    dal.open();
    dal.get_donor_auth({email: credentials.email, password: credentials.password},
      function(err, donor)
      {
        dal.close();
        if(err)
        {
          next(err);
          return;
        }

        if(donor)
        {
          auth_requests[ip].attempts=0;//reset auth requests
          request.session.auth = donor;
          response.json(
            {
              auth: true,
              donor_id: request.session.auth.id,
              first_name: request.session.auth.first_name,
              last_name: request.session.auth.last_name,
              email: request.session.auth.email
            });
        }
        else
        {
          request.session.auth = null;
          response.json(
            {
              auth: false,
              require_captcha: (auth_requests[ip].attempts >= 3)
            });
        }

      }); //end get_donor_auth
  } //end validate_auth
  if(require_captcha)
  {
    if(!request.body.recaptcha_response_field)
    {
      response.json(
        {
          auth: false,
          require_captcha: true,
          recaptcha_success: false
        });
      return;
    }
    var recaptcha = new Recaptcha(
                          conf.recaptcha_public_key, 
                          conf.recaptcha_private_key,
                          {
                            remoteip: ip,
                            challenge: request.body.recaptcha_challenge_field,
                            response: request.body.recaptcha_response_field
                          });
    recaptcha.verify(
      function(success, error_code)
      {
        if(success)
          validate_auth();
        else
          response.json(
            {
              auth: false,
              require_captcha: true,
              recaptcha_success: false
            });
      });
  }
  else
    validate_auth();
    
}

/**
 * Logs the authenticated user out by clearing the auth object out of the session
 */
exports.logout = function(request,response)
{
  request.session.auth = null;
  response.json(
    {
      auth: false
    });
}

/**
 * Update the email address of the donor currently in session
 */
exports.update_donor_email = function(request, response)
{
  var donor_email = escapeHtml(request.body["email"]);
  dal.open();
  dal.update_donor({id: request.session.auth.id, email: donor_email},
    function(err)
    {
      dal.close();
      if(err)
      {
        response.json(
          {
            success:false,
            message:"Error saving email"
          });
          return;
      }
      response.json(
        {
          success:true,
          message:""
        });
        return;
    });
}

/**
 * Lookup donor information based on email address, return JSON formated donor
 */
exports.get_donor = function(request, response)
{
  var donor_email = escapeHtml(request.body["donor_email"]);
  dal.open();
  dal.get_donor({email: donor_email},
    function(err, donor)
    {
      dal.close();
      if(err)
      {
        reponse.json(
          {
            success: false,
            message: "There was a problem retrieving email information, please try again later. If this problem persists, please contact technical support with the following information: " + err.message
          }
        );
        return;
      }

      console.log("donor_id: " + request.session.donor_id);
      request.session.donor=donor;

      response.json(
        {
          success: true,
          message: "",
          new_donor: donor.processor_id ? false : true 
        });
    });
}

/**
 * Retrieve the donation history for the logged in user
 */
exports.get_donation_history = function(request, response)
{
  dal.open();
  dal.get_donation_history(request.session.auth.id,
    function(err, rows)
    {
      dal.close();
      if(err)
      {
        return reponse.json(
          {
            success: false,
            message: "There was a problem retrieving donation history, please try again later. If this problem persists, please contact technical support with the following information: " + err.message
          }
        );
      }

      return response.json(
        {
          success: true,
          message: "",
          rows: rows
        });

    });

}

/**
 * Retrieve charity information. For now, the only information that is sent is the charity name
 */
exports.get_charity = function(request, response)
{
  
  if(request.session.charity)
    response.json(
      {
        status: "ok",
        name: request.session.charity.charity_name
      });
  else
    response.json(
      {
        status: "error",
        message: "no charity in session"
      });
}

/**
 * Register the charity with Dwolla, then save it to the database
 */
exports.register_charity = function(request, response)
{
  var charity_info = {};

  //dwolla's test environment is non-functional for registration, so we have to simulate a success for testing
  if(conf.env == "development")
  {
     response.json(
            {
              success: true,
              message: "Success",
              charity_id: 123
            });
      return;
  }


  //sanitize
  for(key in request.body) { charity_info[key] = escapeHtml(request.body[key]); }
  payment.register(
    {
      email: charity_info.email,
      password: charity_info.password,
      pin: charity_info.pin,
      firstName: charity_info.first_name,
      lastName: charity_info.last_name,
      address: charity_info.address,
      city: charity_info.city,
      state: charity_info.state,
      zip: charity_info.zip,
      phone: charity_info.phone,
      dateOfBirth: charity_info.dob,
      organization: charity_info.charity_name,
      ein: charity_info.ein,
      acceptTerms: charity_info.accept_terms
    },
    function(err,result)
    {
      if(err)
      {
        response.json(
          {
            success: false,
            message: err.message + " :" + (result ? (result.Message  || "") : ""),
            errors: result.Response
          });
          return;
      }

      //save charity to db
      dal.open();
      dal.save_charity(
        {
          charity_name: charity_info.charity_name,
          address1: charity_info.address,
          address2: '',
          city: charity_info.city,
          state: charity_info.state,
          zip: charity_info.zip,
          mailing_address1: charity_info.mailing_address,
          mailing_address2: '',
          mailing_city: charity_info.mailing_city,
          mailing_state: charity_info.mailing_state,
          mailing_zip: charity_info.mailing_zip,
          dwolla_id: result.Response.Id,
          first_name: charity_info.first_name,
          last_name: charity_info.last_name,
          title: charity_info.title,
          board_type: charity_info.board_type,
          email: charity_info.email,
          phone: charity_info.phone,
          domain: URI.parse(charity_info.domain).hostname.split(".").slice(-2).join("."), //discard subdomains
          dob: charity_info.dob,
          ein: '' //not storing ein, for legal purposes 
        },
        function(err, charity_id)
        {
          dal.close(); 
          if(err)
          {
            response.json(
              {
                success: false,
                message: "Your registration with Dwolla was successfull, but there was an internal problem saving your account information with Klear Choice. We hope to have this issue resolved soon, but until we do, please use the manual registration method and enter your Dwolla ID."
              });

              return;
          }
          mandrill.messages.sendTemplate(
            {
              template_name:"charity_registration_notification",
              template_content: [
                {name:"charity_name", content: charity_info.charity_name},
                {name:"charity_id", content: charity_id},
                {name:"address1", content: charity_info.address1},
                {name:"address2", content: charity_info.address2},
                {name:"city", content: charity_info.city},
                {name:"state", content: charity_info.state},
                {name:"zip", content: charity_info.zip},
                {name:"mailing_address1", content: charity_info.mailing_address1},
                {name:"mailing_address2", content: charity_info.mailing_address2},
                {name:"mailing_city", content: charity_info.mailing_city},
                {name:"mailing_state", content: charity_info.mailing_state},
                {name:"mailing_zip", content: charity_info.mailing_zip},
                {name:"first_name", content: charity_info.first_name},
                {name:"last_name", content: charity_info.last_name},
                {name:"title", content: charity_info.title},
                {name:"email", content: charity_info.email},
                {name:"phone", content: charity_info.phone},
                {name:"domain", content: charity_info.domain},
                {name:"board_type", content: charity_info.board_type}
                  ],
                  message: {
                    to: [
                      {email:"support@klearchoice.com"},
                    ],
                    tracking_domain: "klearchoice.com"
                  }

            },
            function(){log.debug("email sent successfully");}, //success, do nothing
            function(err){console.error(util.inspect(err));} //error
          );

          response.json(
            {
              success: true,
              message: "Success",
              charity_id: charity_id
            });
        }); //end dal.save_charity()
    }); //end payment.register()
} //end register_charity

/**
 * Save charity information to the database. 
 * This is called when the charity has an existing dwolla id and doesn't need to register
 *TODO: make this work for updating charity info instead of just inserts
 */
exports.save_charity = function(request, response)
{
  var charity_info = {};
  //sanitize
  for(key in request.body) { charity_info[key] = escapeHtml(request.body[key]); }

  //save charity to db
  dal.open();
  dal.save_charity(
    {
      charity_name: charity_info.charity_name,
      address1: charity_info.address,
      address2: '',
      city: charity_info.city,
      state: charity_info.state,
      zip: charity_info.zip,
      mailing_address1: charity_info.mailing_address,
      mailing_address2: '',
      mailing_city: charity_info.mailing_city,
      mailing_state: charity_info.mailing_state,
      mailing_zip: charity_info.mailing_zip,
      dwolla_id: charity_info.dwolla_id,
      first_name: charity_info.first_name,
      last_name: charity_info.last_name,
      title: charity_info.title,
      board_type: charity_info.board_type,
      email: charity_info.email,
      phone: charity_info.phone,
      domain: URI.parse(charity_info.domain).hostname.split(".").slice(-2).join("."), //discard subdomain
      dob: charity_info.dob,
      ein: '' //not storing ein, for legal purposes 
    },
    function(err, charity_id)
    {
      dal.close(); 
      if(err)
      {
        response.json(
          {
            success: false,
            message: "There was an internal problem saving your account information with Klear Choice. We hope to have this issue resolved soon."
          });

        return;
      }

      mandrill.messages.sendTemplate(
        {
          template_name:"charity_registration_notification",
          template_content: [
            {name:"charity_name", content: charity_info.charity_name},
            {name:"charity_id", content: charity_id},
            {name:"address", content: charity_info.address},
            {name:"city", content: charity_info.city},
            {name:"state", content: charity_info.state},
            {name:"zip", content: charity_info.zip},
            {name:"mailing_address", content: charity_info.mailing_address},
            {name:"mailing_city", content: charity_info.mailing_city},
            {name:"mailing_state", content: charity_info.mailing_state},
            {name:"mailing_zip", content: charity_info.mailing_zip},
            {name:"first_name", content: charity_info.first_name},
            {name:"last_name", content: charity_info.last_name},
            {name:"title", content: charity_info.title},
            {name:"email", content: charity_info.email},
            {name:"phone", content: charity_info.phone},
            {name:"domain", content: charity_info.domain},
            {name:"board_type", content: charity_info.board_type}
          ],
          message: {
            to: [
              {email:"support@klearchoice.com"}
            ],
            tracking_domain: "klearchoice.com"
          }

            },
            function(){log.debug("email sent successfully");}, //success, do nothing
            function(err){console.error(util.inspect(err));} //error
          );

      response.json(
        {
          success: true,
          message: "Success",
          charity_id: charity_id
        });
    }); //end dal.save_charity()
}

/**
 * Retrieve the donation history for the donor
 */
exports.get_donation_history = function(request, response)
{
  dal.open();
  dal.get_donation_history(request.session.auth.id,
    function(err, rows)
    {
      dal.close();
      if(err)
      {
        log.error("Error retrieving donation history: " + util.inspect(err));
        return response.json(
          {
            success: false,
            message: "Error retreiving donation history"
          });
      }

      response.json(
        {
          success: true,
          message: "",
          rows: rows
        });
    });
}

/*******************************
 * Subscription API calls
 *******************************/

/**
 * Retrieve a list of subscriptions for the authenticated donor
 */
 exports.get_subscriptions = function(request, response)
 {
  dal.open()
  dal.get_recurring_transactions(request.session.auth.id,
    function(err, rows)
    {
      dal.close();
      if(err)
      {
        log.error(util.inspect(err));
        return response.json(
          {
            success: false,
            message: "Error retreiving subscriptions"
          });
      }
      response.json(
        {
          success: true,
          message: "",
          subscriptions: rows
        });
    });
 }

/**
 * API method to create a new recurring donation/transaction
 */
exports.create_subscription = function(request, response)
{
  var valid_frequencies = ["daily","weekly","biweekly","monthly"];
  log.debug("create subscription - frequency: " + request.body["frequency"] + " amount: " + request.body["amount"]);
  if(!(valid_frequencies.indexOf(request.body["frequency"]) >= 0))
    return response.json(
      {
        success: false,
        message: "Invalid or missing frequency"
      });
  if(isNaN(parseFloat(request.body["amount"])))
    return response.json(
      {
        success: false,
        message: "Missing or invalid amount"
      });
  dal.open();
  dal.create_subscription(
      {
        amount: parseFloat(request.body["amount"]),
        frequency: request.body["frequency"],
        donor_id: request.session.auth.id,
        charity_id: request.session.charity.id,
        next_transaction_date: date_string(getNextSubscriptionDate(request.body["frequency"],new Date()))
      },
      function(err, result)
      {
        dal.close();
        if(err)
        {
          log.error("Error creating recurring subscription: " + util.inspect(err));
          return response.json(
            {
              success: false,
              message: "Error creating recurring subscription"
            });
        }

        response.json(
          {
            success: true,
            message: ""
          });
      });
}

/**
 * Cancel subscription for the authenticated donor, for the 
 * passed in subscription_id
 */
exports.cancel_subscription = function(request, response)
{
  var subscription_id = request.body["subscription_id"];
  log.log("Canceling subscription: " + subscription_id);
  if(!subscription_id)
    return response.json(
      {
        success: false,
        message: "Missing subscription_id"
      });
  dal.open();
  dal.cancel_subscription(subscription_id,
    function(err, result)
    {
      if(err)
      {
        log.error("Error canceling subscription: " + util.inspect(err));
        return response.json(
          {
            success: false,
            message: "Failed to cancel subscription"
          });
      }

      response.json(
        {
          success: true,
          message: ""
        });
    });

}

/* Utility functions */

/**
 * This does the guest_send call, logging and error handling.
 */
function send_payment(request, response, data, donor_id)
{
  log.debug("sending payment...");

  //send out the payment request
  payment.guest_send(
    {
      destination_id: request.session.charity.dwolla_id,
      amount: data.amount,
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      routing_number: data.routing_number,
      account_number: data.account_number,
      account_type: data.account_type,
      charity_name: request.session.charity.charity_name,
      charity_id: request.session.charity.id
    },
    function(err,results)
    {
      if(err)
      {
        log.error(err);
        dal.log_transaction(
          {
            donor_id: donor_id,
            charity_id: request.session.charity.id,
            amount: data.amount,
            klearchoice_fee: payment.klearchoice_fee(data.amount),
            processor_fee: payment.processor_fee(data.amount),
            status: "error",
            message: err,
            log: (new Date()).toString() + "Error: " + err
          },
          function()
          {
            dal.close();
          });
          response.json(
            {
              success: false,
              message: "Error sending transaction to payment processor"
            });
            return;
      }
	
      if(!results.Success)
      {
        console.log(util.inspect(results));
        dal.log_transaction(
          {
            donor_id: donor_id,
            charity_id: request.session.charity.id,
            amount: data.amount,
            klearchoice_fee: payment.klearchoice_fee(data.amount),
            processor_fee: payment.processor_fee(data.amount),
            status: "error",
            message: util.inspect(results),
            log: (new Date()).toString() + "Error: " + util.inspect(results)
          },
          function(insertResult)
          {
            dal.close();
          });
          response.json(
            {
              success: false,
              message: results.Message
            });
            return;
      }

      //request succeeded
      dal.log_transaction(
        {
          donor_id: donor_id,
          charity_id: request.session.charity.id,
          amount: data.amount,
          klearchoice_fee: payment.klearchoice_fee(data.amount),
          processor_fee: payment.processor_fee(data.amount),
          status: "processed",
          message: "Successfully posted transaction",
          log: (new Date()).toString() + "Successfully posted transaction",
          processor_transaction_id: results.Response
        },
        function(err,insertResult)
        {
          var transactionId=0;
          transactionId=insertResult.insertId;
          dal.close();
          //send confirmation email
          var clear_date = new Date().getTime();
          //add three days
          clear_date += (3 * 24 * 60 * 60 * 1000);
          //now keep adding days until we hit a business day, i.e., one that isn't saturday (6) or sunday (0)
          for(var i=0; i<3;i++)
          {
            if(
              (
                (new Date(clear_date))
                .getDay() != 6
              )
              &&
              (
                (new Date(clear_date))
                .getDay() != 0
              )
            ) break;
    
            clear_date += (24 * 60 * 60 * 1000);
          }
    
          clear_date = new Date(clear_date);
          var clear_date_formatted = (clear_date.getMonth() + 1) + "/" + clear_date.getDate() + "/" + clear_date.getFullYear();
          try
          {
            log.debug("sending confirmation email...");
            mandrill.messages.sendTemplate(
              {
                template_name:"donorpaymentsent",
                template_content: [
                  {name:"first_name", content:data.first_name},
                  {name:"last_name", content:data.last_name},
                  {name:"charity", content:request.session.charity.charity_name},
                  {name:"account_number", content:"XXXXXX" + data.account_number.slice(-3)},
                  {name:"amount", content: formatCurrency(parseFloat(data.amount) + payment.klearchoice_fee(data.amount) + payment.processor_fee(data.amount)) },
                  {name:"clear_date", content:clear_date_formatted},
                  {name:"transaction_number", content:transactionId},
                ],
                message: {
                  to: [
                        {email:data.email, name:data.first_name + " " + data.last_name}
                      ],
                  tracking_domain: "klearchoice.com"
                }
    
              },
              function(){}, //success, do nothing
              function(err){console.error(util.inspect(err));} //error
              );
         }
         catch(e) { console.error("error sending email: " + util.inspect(e)); }
    
         response.json(
           {
             success: true
           });
      }); //end log transaction
      
    } //end http request callback
  );//end request call to dwolla
} //end send_payment


/**
 * Simple utility function to format currency, deals with sign and commas
 */
function formatCurrency(num) {
  num = num.toString().replace(/\$|\,/g, '');
  if (isNaN(num)) num = "0";
  sign = (num == (num = Math.abs(num)));
  num = Math.floor(num * 100 + 0.50000000001);
  cents = num % 100;
  num = Math.floor(num / 100).toString();
  if (cents < 10) cents = "0" + cents;
  for (var i = 0; i < Math.floor((num.length - (1 + i)) / 3); i++)
    num = num.substring(0, num.length - (4 * i + 3)) + ',' + num.substring(num.length - (4 * i + 3));
  return (((sign) ? '' : '-') + '$' + num + '.' + cents);
}

/**
 * This creates the file with the encrypted account credentials
 * to send to the payment server.
 */
function create_secure_account_file(donor,callback)
{
  //encrypt the account details
  donor.account = rsa.encrypt(JSON.stringify(donor.account),conf.account_public_key);

  var write_file = require("./secure_writer").write_file;
  write_file(
    JSON.stringify(donor),
    donor.donor_id.toString() + ".json",
    conf.account_file_target,
    function(err)
    {
      callback(err);
    });
}

/**
 * Tiny utiltiy function to load a template using the views path
 */
function loadTemplate(template) {
    return fs.readFileSync(app.set('views') + template+ '.html')+ '';
}


/** 
 * Utility for scrubbing input, escaping all html to prevent injection/xss
 */
function escapeHtml(unsafe) {
  return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
}

/**
 * Returns a formatted my-sql compliant date string with no time component
 */
function date_string(d)
{
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}
