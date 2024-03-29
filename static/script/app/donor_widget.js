/**
 * donor_widget.js
 */
(
  function()
  {
    var locals = {fee:.5};
    var screen_logic;

    //init google analytics
    var _gaq=[["_setAccount","UA-30533633-2"],['_setDomainName','klearchoice.com']];
    (function(d,t){var g=d.createElement(t),s=d.getElementsByTagName(t)[0];g.async=1;
      g.src=("https:"==location.protocol?"//ssl":"//www")+".google-analytics.com/ga.js";
        s.parentNode.insertBefore(g,s)}(document,"script"));

    //initialize logic for each screen
    screen_logic = {
      /**
       * All of the logic for the guest donation screen
       * This screen has no authentication, and is the most complex of the widget
       */
      donor_widget_no_auth: 
        function()
        {

          _gaq.push(["_trackPageview","/widget/donor_widget_no_auth"]);

          //a little initialization, in case this is a edit/back. The other values are loaded from the template
          if(locals.create_account)
          {
            $("#create_account").attr("checked","checked");
            $("#password_wrapper").fadeIn();
            $("#guest_terms").hide();
            $("#member_terms").show();
          }
          if(locals.accept_member_terms)
            $("#accept_member_terms").attr("checked","checked");
          if(locals.accept_guest_terms)
            $("#accept_guest_terms").attr("checked","checked");

          //gather all the input values
          function get_values()
          {
            $("input").each(
              function()
              {
                var $ele = $(this);
                locals[$ele.attr("id")]=$ele.val();
              });
              locals.amount = parseFloat($("#amount").val().replace("$",""));
              locals.create_account = $("#create_account").is(":checked");
              locals.accept_guest_terms = $("#accept_guest_terms").is(":checked");
              locals.accept_member_terms = $("#accept_member_terms").is(":checked");
              locals.account_type = $("#account_type").val();
          }

          //revalidate each time a form item loses focus
          $("#donation_form input").on("blur",
            function()
            {
              //ie 9 and below don't get responsive validation because it conflict with placeholder shim.
              //if($.browser.msie && $.version < 10) return;

              if(this.validate && !this.validate()) show_error($(this).attr("id"));
              else clear_error($(this).attr("id"));
            });

          //do the password strength meter
          $("#password").on("keyup",
            function()
            {
              var strength = score_password($(this).val());
              if(strength < 50)
              {
                $("#password_strength").html("Strength: <span style='color:red'>Weak</span>");
              }
              else if(strength < 60)
              {
                $("#password_strength").html("Strength: <span style='color:orange'>Ok</span>");
              }
              else if(strength < 80)
              {
                $("#password_strength").html("Strength: <span style='color:blue'>Good</span>");
              }
              else if(strength >= 80)
              {
                $("#password_strength").html("Strength: <span style='color:green'>Great!</span>");
              }
            });


          //set up validations
          $("#amount")[0].validate = validator(
            function()
            {
              var amt = parseFloat($(this).val().replace("$",""));
              if(isNaN(amt)) return false;
              if(amt > 1000) return false;
              return true;
            });
          //just basic validator functions for these. Required validation
          $("#first_name, #last_name, #account_number").each(
            function(){
              this.validate = validator();
            });
          $("#email")[0].validate = validator(
            function()
            {
              //very basic email format validation
              return /\S+@\S+\.\S+/.test($("#email").val());
            }
          );
          $("#confirm_email")[0].validate = validator(
            function()
            {
              //validate that the confirmation email matches
              return ($("#email").val() == $("#confirm_email").val());
            }
          );
          $("#routing_number")[0].validate = validator(
            function()
            {
              //validate the routing number
              return check_aba($("#routing_number").val());
            }
          );
          $("#password")[0].validate = validator(
            function()
            {
              if($("#create_account").is(":checked"))
                if(score_password($("#password").val()) < 50) return false;
              return true;
            }
          );

          $("#confirm_password")[0].validate = validator(
            function()
            {
              if($("#create_account").is(":checked"))
                if(!($("#password").val() == $("#confirm_password").val())) return false;
              return true;
            }

          );

          //show check help dialog when help button is clicked
          $(".help_button").on("click",
            function()
            {
              var id = $(this).attr("id");
              var img = ((id == "account_number_help_button") ? "check_help_account.png" : "check_help_routing.png");
              $("#check_help_img").attr("src","/images/" + img);
              $("#check_help").dialog(
                {
                  width: 500
                });
            });

          //allow only numbers and decimal point
          $("#amount").on("keypress",filter_amount);

          //format the input box for currency
          $("#amount").keyup(format_amount);

          //handle create account click
          $("#create_account").on("click",
            function()
            {
              if($(this).is(":checked"))
              {
                $("#password_wrapper").fadeIn();
                $("#member_terms").show();
                $("#guest_terms").hide();
              }
              else
              {
                $("#password_wrapper").fadeOut();
                $("#member_terms").hide();
                $("#guest_terms").show();
              }
            });

          //handle submit click
          $("#submit_no_auth").on("click",
            function()
            {
              if(!validate())
                return;
              get_values();
              show_loader();
              show_screen("donor_widget_confirm");
            });

          //handle login click
          $("#login_button").on("click",
            function()
            {
              show_loader();
              $.post("auth",
                {
                  email: $("#login_email").val(),
                  password: $("#login_password").val()
                },
                function(data,textStatus,jqXHR)
                {
                  if(data.auth)
                  {
                    locals = $.extend(locals,data);
                    return show_screen("donor_widget_auth");
                  }
                  hide_loader();
                  if(data.require_captcha)
                  {
                    $("#login").empty().html("Too many login attempts. Please wait 5 minutes or <a href='/profile.html' target='_blank'>click here</a> to recover your password.");
                  }
                  else
                    $("#login_error").html("Invalid login");
                }
              );
            });

          
        },

      /**
       * Logic for the authorized member donation screen.
       * When a member logs in, they can use this simplified screen
       */
      donor_widget_auth:
        function()
        {
          _gaq.push(["_trackPageview","/widget/donor_widget_auth"]);
          //handle logout click
          $("#logout").on("click",
            function()
            {
              show_loader();
              $.post("logout", {},
                function(data,textStatus,jqXHR)
                {
                  show_screen("donor_widget_no_auth");
                }
              );
            });

          //allow only numbers and decimal point
          $("#auth_amount").on("keypress",filter_amount);

          //format the input box for currency
          $("#auth_amount").keyup(format_amount);
          
          //initialize the validator for the amount input
          $("#auth_amount")[0].validate = validator(
            function()
            {
              var amt = parseFloat($(this).val().replace("$",""));
              if(isNaN(amt)) return false;
              if(amt < 1 || amt > 2000) return false;
              return true;
            });

          $("#submit_auth").on("click",
            function()
            {
              if(!validate()) return;
              locals.amount = parseFloat($("#auth_amount").val().replace("$",""));
              show_screen("donor_widget_confirm");
            });
          
        },
      /**
       * Logic for the donation confirmation screen
       */
      donor_widget_confirm:
        function()
        {
          _gaq.push(["_trackPageview","/widget/donor_widget_confirm"]);
          //set the correct amount in the UI and format it
          $("#donation_total_display").html(parseFloat(locals.amount) + locals.fee);
          $("#donation_total_display").formatCurrency({ colorize: false, negativeFormat: '-%s%n', roundToDecimalPlace: 2, eventOnDecimalsEntered: true });
          $("#donation_amount_display").formatCurrency({ colorize: false, negativeFormat: '-%s%n', roundToDecimalPlace: 2, eventOnDecimalsEntered: true });

          //handle back click
          $("#submit_confirm_back").on("click",
            function()
            {
              if(locals.auth)
                show_screen("donor_widget_auth");
              else
                show_screen("donor_widget_no_auth");
            });

          //handle submit click.
          $("#submit_no_auth").on("click",
            function()
            {
              show_loader();
              $.post("donate",locals)
                .done(
                  function(data,status,xhr)
                  {
                    if(data.success)
                      return show_screen("donor_widget_thank_you");

                    alert("There was a problem processing your payment: " + data.message);
                  }
                )
                .fail(
                  function(xhr,status,err)
                  {
                    alert("error processing donation, please try again later. Status:" + status + " Error: " + err);
                  });
            });

        },
      /**
       * Logic for the thank you screen
       */
      donor_widget_thank_you:
        function()
        {
          _gaq.push(["_trackPageview","/widget/donor_widget_thank_you"]);
          if(locals.auth)
          {
            $("#recurring_container").show();
          }

          $("#amount_display").formatCurrency({ colorize: false, negativeFormat: '-%s%n', roundToDecimalPlace: 2});

          
          $("#recurring").on("click",
            function()
            {
              if($("#recurring").is(":checked"))
                $("#recurring_options").fadeIn();
              else
                $("#recurring_options").fadeOut();
            });
          $("#create_recurring_donation").on("click",
            function()
            {
              locals.frequency = $("#frequency").val();
              $.post("/subscription/create",locals)
                .done(
                  function(result)
                  {
                    if(!result.success)
                      return alert("Error creating recuring subscription, please try again later");
                    $("#recurring_container").fadeOut(
                      {
                        done: function()
                          {
                            $("#recurring_created").fadeIn();
                          }
                      });
                  })
                .fail(
                  function()
                  {
                    alert("Error creating recuring subscription, please try again later");
                  });
            });
        }
    };

    /*********************** Utility Functions **********************/

    /**
     * Show the loader overlay
     */
    function show_loader()
    {
      $("#loader").show();
    }
    
    /**
     * Hide the loader
     */
    function hide_loader()
    {
      $("#loader").hide();
    }

    /**
     * calculate the password strength
     */
    function score_password(pass) {
      var score = 0;
      if (!pass)
        return score;

      // award every unique letter until 5 repetitions
      var letters = new Object();
      for (var i=0; i<pass.length; i++) {
        letters[pass[i]] = (letters[pass[i]] || 0) + 1;
        score += 5.0 / letters[pass[i]];
      }

      // bonus points for mixing it up
      var variations = {
        digits: /\d/.test(pass),
        lower: /[a-z]/.test(pass),
        upper: /[A-Z]/.test(pass),
        nonWords: /\W/.test(pass),
      }

      variationCount = 0;
      for (var check in variations) {
        variationCount += (variations[check] == true) ? 1 : 0;
      }
      score += (variationCount - 1) * 10;

      return parseInt(score);
    }


    /**
     * Basic char code filtering for numeric and decimal
     */
    function filter_amount(evt)
    {
      var ch = String.fromCharCode(evt.charCode);
      if(ch == ".") return;
      if(isNaN(parseInt(ch)))
      {
        evt.preventDefault();
        return false;
      }
    }

    /**
     * validate the routing number according to ABA standard
     */
    function check_aba(s) {

      var i, n, t;

      // First, remove any non-numeric characters.

      t = "";
      for (i = 0; i < s.length; i++) {
        c = parseInt(s.charAt(i), 10);
        if (c >= 0 && c <= 9)
          t = t + c;
      }

      // Check the length, it should be nine digits.

      if (t.length != 9)
        return false;

      // Now run through each digit and calculate the total.

      n = 0;
      for (i = 0; i < t.length; i += 3) {
        n += parseInt(t.charAt(i),     10) * 3
        +  parseInt(t.charAt(i + 1), 10) * 7
        +  parseInt(t.charAt(i + 2), 10);
      }

      // If the resulting sum is an even multiple of ten (but not zero),
      // the aba routing number is good.

      if (n != 0 && n % 10 == 0)
        return true;
      else
        return false;
    }



    /**
     * Handle keyboard filtering and currency formatting for the amount text boxes
     */
    function format_amount(e)
    {
      var keyUnicode = e.charCode || e.keyCode;

      if (e !== undefined) {
        switch (keyUnicode) {
          case 16: break; // Shift
          case 17: break; // Ctrl
          case 18: break; // Alt
          case 27: this.value = ''; break; // Esc: clear entry
          case 35: break; // End
          case 36: break; // Home
          case 37: break; // cursor left
          case 38: break; // cursor up
          case 39: break; // cursor right
          case 40: break; // cursor down
          case 78: break; // N (Opera 9.63+ maps the "." from the number key section to the "N" key too!) (See: http://unixpapa.com/js/key.html search for ". Del")
          case 110: break; // . number block (Opera 9.63+ maps the "." from the number block to the "N" key (78) !!!)
          case 190: break; // .
          default: $(this).formatCurrency({ colorize: true, negativeFormat: '-%s%n', roundToDecimalPlace: -1, eventOnDecimalsEntered: true });
        }
      }
      var new_val = $(this).val();
      var decimal_pos = new_val.indexOf(".");
      if(decimal_pos <=0) return;
      if((new_val.length - decimal_pos - 1) > 2)
      {
        //strip decimals more than 2 places
        $(this).val(new_val.substr(0,new_val.length - 1));
      }
    }

    /**
     * Utility function for wrapping validators. Handles required fields
     */
    function validator(fn)
    {
      return function()
      {
        if(($(this).attr("required") == "required"))
        {
          if(!($(this).val())) return false;
          if ( this.value == $(this).attr("placeholder") ) return false;
        }

        if(fn)
          return fn.apply(this);

        return true
      }
    }

    /**
     * Validate the inputs on the currently active screen
     */
    function validate()
    {
      var valid=true;
      $(".error").removeClass("error");
      $(".validation").hide();

      //validate all fields
      $("input").each(
        function()
        {
          if(this.validate && !this.validate())
            valid = show_error($(this).attr("id"));
        });

        return valid;
    }

    /**
     * Change the class and show the error tooltip
     */
    function show_error(id)
    {
      $("#" + id).addClass("error");
      $("[for='" + id + "']").css("display","inline-block");
      return false; //this is just to save curly brackets typing
    }

    /**
     * Clear the error display
     */
    function clear_error(id)
    {
      $("#" + id).removeClass("error");
      $("[for='" + id + "']").fadeOut();
    }

    /**
     * Transition to the specified screen
     */
    function show_screen(screen)
    {
      var fragment = screen + ".html";
      $.get("/html/fragments/" + fragment,
        function(data,status,jqXHR)
        {
          var content = Mustache.render(data,locals);
          hide_loader();
          if($("#content").html()=="")
          {
            $("#content").html(content);
            if(screen_logic[screen]) screen_logic[screen]();
            placeholder();

          }
          else
            $("#content").fadeOut(
              function()
              {
                $(this)
                  .html(content)
                  .fadeIn(
                    function()
                    {
                      if(screen_logic[screen]) screen_logic[screen]();
                      placeholder();
                    }
                  );
              });
        });
    }

    function placeholder()
    {
      if ( !("placeholder" in document.createElement("input")) ) {
        $("input[placeholder], textarea[placeholder]").each(function() {
          var val = $(this).attr("placeholder");
          if ( this.value == "" ) {
            this.value = val;
          }
          $(this).focus(function() {
            if ( this.value == val ) {
              this.value = "";
            }
          }).blur(function() {
            if ( $.trim(this.value) == "" ) {
              this.value = val;
            }
          })
        });

        // Clear default placeholder values on form submit
        $('form').submit(function() {
          $(this).find("input[placeholder], textarea[placeholder]").not("input[type=password]").each(function() {
            if ( this.value == $(this).attr("placeholder") ) {
              this.value = "";
            }
          });
        });
      }

    }


    /**
     * Main
     */
    $(document).ready(
      function()
      {
        $.getJSON("/charity",
          function(charity, status, jqXHR)
          {
            if(charity && charity.status && charity.status == "ok")
            {
              locals.charity_name = charity.name;

              $.getJSON("/auth",
                function(data,status,jqXHR)
                {
                  if(data.auth)
                  {
                    locals = $.extend(locals,data);
                    show_screen("donor_widget_auth");
                  }
                  else
                  {
                    locals.auth = null;
                    show_screen("donor_widget_no_auth");
                  }
                });
            }
            else
            {
              show_screen("donor_widget_error");
            }

            /*listen for "show" message and hook up html5 placeholder shim
            I curse IE. It caused these shenanigans.
            The basic issue here is that we need the placeholder shim to execute on an item that's already loaded in the DOM. Since
            the widget is initially hidden, we have to wait for the hosting page to post a message to tell us that the widget is visible.*/
            $(window).on("message",
              function(evt)
              {
                var data = evt.originalEvent.data;
                if(data == "show")
                {
                  //html5 placeholder shim for IE
                  jQuery.placeholder.shim();
                }
              });

          });
      });


  }
)();
